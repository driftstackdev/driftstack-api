import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createLiveLatencyStore,
  LiveLatencySubscriber,
} from '../../src/components/LiveLatencySubscriber';

describe('LiveLatencySubscriber', () => {
  it('updates RTT readouts without rerendering the simulator parent', () => {
    const store = createLiveLatencyStore();
    let parentRenders = 0;
    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <LiveLatencySubscriber store={store}>
          {(latency) => <span data-testid="rtt">{latency.rttMs ?? '—'}ms</span>}
        </LiveLatencySubscriber>
      );
    }

    render(<SimulatorHost />);
    act(() => store.set({ rttMs: 82, lastSeenAt: 1234 }));
    expect(screen.getByTestId('rtt').textContent).toBe('82ms');
    expect(parentRenders).toBe(1);
    expect(store.getSnapshot()).toEqual({ rttMs: 82, lastSeenAt: 1234 });
  });
});
