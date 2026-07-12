import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from '../../src/components/ErrorBanner';

describe('ErrorBanner', () => {
  it('keeps existing callers dismiss-only by default', () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="Something went wrong" onDismiss={onDismiss} />);

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs an explicit retry once and names its in-flight state', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ErrorBanner message="Could not load profiles" onDismiss={vi.fn()} onRetry={onRetry} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ErrorBanner
        message="Could not load profiles"
        onDismiss={vi.fn()}
        onRetry={onRetry}
        retrying
      />,
    );
    const retrying = screen.getByRole('button', { name: 'Retrying…' });
    expect(retrying).toBeDisabled();
    expect(retrying).toHaveAttribute('aria-busy', 'true');
  });
});
