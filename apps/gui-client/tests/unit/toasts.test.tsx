// ToastProvider — push/dismiss/action contract + the 3-visible cap.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToasts } from '../../src/lib/toasts';

afterEach(cleanup);

function Pusher({ onReady }: { onReady: (push: ReturnType<typeof useToasts>['push']) => void }) {
  const { push } = useToasts();
  onReady(push);
  return null;
}

function setup() {
  let pushFn: ReturnType<typeof useToasts>['push'] = () => {};
  render(
    <ToastProvider>
      <Pusher
        onReady={(p) => {
          pushFn = p;
        }}
      />
    </ToastProvider>,
  );
  return {
    push: (t: Parameters<typeof pushFn>[0]) => {
      act(() => pushFn(t));
    },
  };
}

describe('ToastProvider', () => {
  it('renders pushed toasts with title + body and dismisses on ✕', () => {
    const { push } = setup();
    push({ title: 'Session paused', body: 'tap to resolve' });
    expect(screen.getByText('Session paused')).toBeDefined();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Session paused')).toBeNull();
  });

  it('the action button runs then dismisses', () => {
    const run = vi.fn();
    const { push } = setup();
    push({ title: 'Crash', action: { label: 'Open', run } });
    fireEvent.click(screen.getByText('Open'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Crash')).toBeNull();
  });

  it('caps the visible stack at 3 (oldest dropped)', () => {
    const { push } = setup();
    for (const n of ['one', 'two', 'three', 'four']) push({ title: n });
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByText('four')).toBeDefined();
  });

  it('useToasts outside the provider throws', () => {
    function Naked() {
      useToasts();
      return null;
    }
    expect(() => render(<Naked />)).toThrow(/requires <ToastProvider>/);
  });
});
