import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createDownloadsListStore,
  DownloadsListSubscriber,
} from '../../src/components/DownloadsListSubscriber';

describe('DownloadsListSubscriber', () => {
  it('updates the download badge without rerendering its simulator parent', () => {
    const store = createDownloadsListStore();
    let parentRenders = 0;
    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <DownloadsListSubscriber store={store}>
          {(downloads) => <span data-testid="count">{downloads?.length ?? 0}</span>}
        </DownloadsListSubscriber>
      );
    }

    render(<SimulatorHost />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    act(() =>
      store.set([
        { name: 'receipt.pdf', size: 42, mime: 'application/pdf' },
        { name: 'export.csv', size: 84, mime: 'text/csv' },
      ]),
    );
    expect(screen.getByTestId('count').textContent).toBe('2');
    expect(parentRenders).toBe(1);
  });
});
