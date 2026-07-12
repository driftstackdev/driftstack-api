import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTransientNotice } from '../../src/lib/use-transient-notice';

function NoticeHarness(): JSX.Element {
  const { notice, showNotice } = useTransientNotice();
  return (
    <div>
      <span>{notice ?? 'none'}</span>
      <button type="button" onClick={() => showNotice('first', 1_000)}>
        First
      </button>
      <button type="button" onClick={() => showNotice('second', 2_000)}>
        Second
      </button>
    </div>
  );
}

describe('useTransientNotice', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not let an older expiry erase a newer notice', () => {
    vi.useFakeTimers();
    render(<NoticeHarness />);

    void act(() => screen.getByRole('button', { name: 'First' }).click());
    void act(() => vi.advanceTimersByTime(900));
    void act(() => screen.getByRole('button', { name: 'Second' }).click());
    void act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText('second')).not.toBeNull();

    void act(() => vi.advanceTimersByTime(1_800));
    expect(screen.getByText('none')).not.toBeNull();
  });
});
