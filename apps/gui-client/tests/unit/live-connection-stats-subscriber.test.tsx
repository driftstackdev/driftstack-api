import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createLiveConnectionStatsStore,
  LiveConnectionStatsSubscriber,
} from '../../src/components/LiveConnectionStatsSubscriber';
import { EMPTY_CONNECTION_STATS } from '../../src/lib/livekit-connection-stats';

describe('LiveConnectionStatsSubscriber', () => {
  it('updates transport diagnostics without rerendering the simulator parent', () => {
    const store = createLiveConnectionStatsStore();
    let parentRenders = 0;
    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <LiveConnectionStatsSubscriber store={store}>
          {(stats) => <span data-testid="transport">{stats.transport ?? 'unknown'}</span>}
        </LiveConnectionStatsSubscriber>
      );
    }

    render(<SimulatorHost />);
    act(() =>
      store.set({
        // Spread the module's own default so this fixture cannot go stale again
        // — it was already missing ten fields added after it was written.
        ...EMPTY_CONNECTION_STATS,
        transport: 'udp',
        relayed: false,
        rttMs: 44,
        packetLossPct: 0,
        packetLossRecentPct: 0,
        packetsLost: 0,
        packetsReceived: 100,
        jitterMs: 2,
        decodeFps: 30,
        freezeCount: 0,
      }),
    );
    expect(screen.getByTestId('transport').textContent).toBe('udp');
    expect(parentRenders).toBe(1);
  });
});
