// CommandPalette — filter ranking, keyboard navigation, run/close contract.

import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import {
  CommandPalette,
  filterActions,
  type PaletteAction,
} from '../../src/components/CommandPalette';

afterEach(cleanup);

function actions(runs: Record<string, () => void> = {}): PaletteAction[] {
  return [
    { id: 'p1', label: 'Launch · amsterdam-shopper', kind: 'profile', run: runs.p1 ?? (() => {}) },
    { id: 'p2', label: 'Launch · us-retail-qa', kind: 'profile', run: runs.p2 ?? (() => {}) },
    {
      id: 'v1',
      label: 'Go to Sessions',
      kind: 'view',
      keywords: ['nav'],
      run: runs.v1 ?? (() => {}),
    },
    { id: 'a1', label: 'Quick Session', kind: 'action', run: runs.a1 ?? (() => {}) },
  ];
}

describe('filterActions', () => {
  it('empty query returns the head of the list (capped)', () => {
    expect(filterActions(actions(), '').map((a) => a.id)).toEqual(['p1', 'p2', 'v1', 'a1']);
  });

  it('ranks startsWith above substring, case-insensitive', () => {
    expect(filterActions(actions(), 'qu').map((a) => a.id)).toEqual(['a1']); // startsWith only
    const sub = filterActions(actions(), 'retail').map((a) => a.id);
    expect(sub).toEqual(['p2']); // substring match, case-insensitive
  });

  it('matches keywords too', () => {
    expect(filterActions(actions(), 'nav').map((a) => a.id)).toEqual(['v1']);
  });
});

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CommandPalette open={false} actions={actions()} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters as the user types and runs the cursored action on Enter (closing first)', () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open actions={actions({ a1: run })} onClose={onClose} />);
    const input = screen.getByLabelText('Command palette search');
    fireEvent.change(input, { target: { value: 'quick' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move the cursor; Escape closes without running', () => {
    const run1 = vi.fn();
    const run2 = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open actions={actions({ p1: run1, p2: run2 })} onClose={onClose} />);
    const input = screen.getByLabelText('Command palette search');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run1).not.toHaveBeenCalled();
    expect(run2).not.toHaveBeenCalled();
  });

  it('shows the empty state when nothing matches', () => {
    render(<CommandPalette open actions={actions()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Command palette search'), {
      target: { value: 'zzz-nope' },
    });
    expect(screen.getByText('No matches.')).toBeDefined();
  });

  it('exposes the overlay as a modal dialog (role=dialog + aria-modal) for assistive tech', () => {
    render(<CommandPalette open actions={actions()} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-component')).toBe('command-palette');
  });

  it('keeps the closing dialog inert for its exit transition, then removes it', async () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <CommandPalette open actions={actions()} onClose={() => {}} />,
      );
      rerender(<CommandPalette open={false} actions={actions()} onClose={() => {}} />);

      const exiting = container.querySelector('[data-component="command-palette"]');
      expect(exiting).not.toBeNull();
      expect(exiting).toHaveAttribute('aria-hidden', 'true');
      expect(exiting).toHaveAttribute('inert');
      expect(exiting).toHaveClass('pointer-events-none', 'animate-modal-backdrop-out');

      await act(() => vi.advanceTimersByTime(120));
      expect(container.querySelector('[data-component="command-palette"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
