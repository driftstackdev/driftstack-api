// ShortcutsCheatsheet overlay (5→10 polish). Asserts the closed/open contract,
// that it documents the real shortcuts, closes on Escape / backdrop / the esc
// button, and exposes a labelled dialog for a11y.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ShortcutsCheatsheet } from '../../src/components/ShortcutsCheatsheet';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ShortcutsCheatsheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ShortcutsCheatsheet open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    cleanup();
  });

  it('renders a labelled dialog with the real shortcut groups when open', () => {
    render(<ShortcutsCheatsheet open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    // Group headings.
    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByText('AI Browser Automation')).toBeTruthy();
    // A couple of real shortcut labels.
    expect(screen.getByText('Command palette')).toBeTruthy();
    expect(screen.getByText('Toggle light / dark')).toBeTruthy();
    expect(screen.getByText('Send message')).toBeTruthy();
    // The (previously undocumented) paste-to-device shortcut is now discoverable.
    expect(screen.getByText('Paste clipboard to the device')).toBeTruthy();
    cleanup();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ShortcutsCheatsheet open onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('closes on the esc button and on backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutsCheatsheet open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Backdrop is the outer overlay; mousedown on it (target === currentTarget) closes.
    const backdrop = container.querySelector(
      '[data-component="shortcuts-cheatsheet"]',
    ) as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('retains an inert, pointer-blocked tree while the exit animation runs', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ShortcutsCheatsheet open onClose={vi.fn()} />);

    rerender(<ShortcutsCheatsheet open={false} onClose={vi.fn()} />);

    const backdrop = container.querySelector(
      '[data-component="shortcuts-cheatsheet"]',
    ) as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop.hasAttribute('inert')).toBe(true);
    expect(backdrop.classList.contains('pointer-events-none')).toBe(true);
    expect(backdrop.classList.contains('animate-modal-backdrop-out')).toBe(true);
  });

  it('removes the retained tree when the 120ms exit finishes', async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ShortcutsCheatsheet open onClose={vi.fn()} />);
    rerender(<ShortcutsCheatsheet open={false} onClose={vi.fn()} />);

    await act(() => vi.advanceTimersByTime(119));
    expect(container.querySelector('[data-component="shortcuts-cheatsheet"]')).toBeTruthy();
    await act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('[data-component="shortcuts-cheatsheet"]')).toBeNull();
  });

  it('cancels a pending exit when the modal reopens', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container, rerender } = render(<ShortcutsCheatsheet open onClose={onClose} />);
    rerender(<ShortcutsCheatsheet open={false} onClose={onClose} />);
    await act(() => vi.advanceTimersByTime(60));

    rerender(<ShortcutsCheatsheet open onClose={onClose} />);
    await act(() => vi.advanceTimersByTime(120));

    const backdrop = container.querySelector(
      '[data-component="shortcuts-cheatsheet"]',
    ) as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(backdrop.hasAttribute('aria-hidden')).toBe(false);
    expect(backdrop.hasAttribute('inert')).toBe(false);
    expect(backdrop.classList.contains('animate-modal-backdrop-in')).toBe(true);
  });

  it('removes immediately on close when reduced motion is preferred', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const { container, rerender } = render(<ShortcutsCheatsheet open onClose={vi.fn()} />);

    rerender(<ShortcutsCheatsheet open={false} onClose={vi.fn()} />);

    expect(container.querySelector('[data-component="shortcuts-cheatsheet"]')).toBeNull();
  });
});
