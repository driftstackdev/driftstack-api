import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createLiveFpsStore, LiveFpsSubscriber } from '../../src/components/LiveFpsSubscriber';

describe('LiveFpsSubscriber', () => {
  it('updates only the subscribed metric subtree, not its parent host', () => {
    const store = createLiveFpsStore();
    let parentRenders = 0;

    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <div>
          <span>stable video host</span>
          <LiveFpsSubscriber store={store}>
            {(fps) => <span data-testid="fps">{fps ?? '—'}fps</span>}
          </LiveFpsSubscriber>
        </div>
      );
    }

    render(<SimulatorHost />);
    expect(screen.getByTestId('fps').textContent).toBe('—fps');
    expect(parentRenders).toBe(1);

    act(() => store.set(30));
    expect(screen.getByTestId('fps').textContent).toBe('30fps');
    expect(parentRenders).toBe(1);

    act(() => store.set(null));
    expect(screen.getByTestId('fps').textContent).toBe('—fps');
    expect(parentRenders).toBe(1);
  });

  it('keeps a synchronous snapshot for Copy diagnostics', () => {
    const store = createLiveFpsStore(24);
    expect(store.getSnapshot()).toBe(24);
    store.set(29);
    expect(store.getSnapshot()).toBe(29);
  });
});
