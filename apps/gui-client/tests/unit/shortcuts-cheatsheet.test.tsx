// ShortcutsCheatsheet overlay (5→10 polish). Asserts the closed/open contract,
// that it documents the real shortcuts, closes on Escape / backdrop / the esc
// button, and exposes a labelled dialog for a11y.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ShortcutsCheatsheet } from '../../src/components/ShortcutsCheatsheet';

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
});
