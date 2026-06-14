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

  it('tones the toast: success → status role + ready border/dot, error → alert + error border', () => {
    const { push } = setup();
    push({ title: 'Recipe saved', tone: 'success' });
    const ok = screen.getByRole('status');
    expect(ok.className).toContain('border-status-ready');
    expect(ok.querySelector('.bg-status-ready')).not.toBeNull();

    push({ title: 'Save failed', tone: 'error' });
    const bad = screen.getByRole('alert');
    expect(bad.className).toContain('border-status-error');
    expect(bad.querySelector('.bg-status-error')).not.toBeNull();
  });

  it('defaults an untoned toast to info (status role, divider border)', () => {
    const { push } = setup();
    push({ title: 'plain' });
    const info = screen.getByRole('status');
    expect(info.className).toContain('border-surface-divider');
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
    // React 18 also logs a caught render error to console.error on a later
    // microtask ("The above error occurred… Consider adding an error boundary").
    // Under full-suite concurrency that async log can surface while a different
    // test file is the active one and trip vitest's unhandled-error detection —
    // a file-order-dependent flake (failed the pre-push gate once 2026-06-13,
    // passed in isolation). Silence console.error for just this intentional
    // throw; the assertion still proves the hook throws without a provider.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Naked />)).toThrow(/requires <ToastProvider>/);
    } finally {
      errSpy.mockRestore();
    }
  });
});
