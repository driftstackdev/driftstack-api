import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MarketplaceView } from '../../src/views/MarketplaceView';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function openTrustedListing(): HTMLElement {
  const signal = screen.getByText(/300\+ sessions over almost a year/);
  const card = signal.closest('button');
  expect(card).not.toBeNull();
  fireEvent.click(card!);

  const modal = document.querySelector('[data-component="marketplace-detail-modal"]');
  expect(modal).not.toBeNull();
  return modal as HTMLElement;
}

describe('MarketplaceView detail modal', () => {
  it('uses the shared enter animation and retains an inert exit tree for 120ms', async () => {
    vi.useFakeTimers();
    render(<MarketplaceView />);

    const modal = openTrustedListing();
    const dialog = screen.getByRole('dialog', { name: 'Profile listing details' });
    expect(modal).toHaveClass('animate-modal-backdrop-in');
    expect(dialog).toHaveClass('animate-modal-panel-in');

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);

    expect(modal).toHaveAttribute('aria-hidden', 'true');
    expect(modal).toHaveAttribute('inert');
    expect(modal).toHaveClass('pointer-events-none', 'animate-modal-backdrop-out');
    expect(dialog).toHaveClass('animate-modal-panel-out');

    await act(() => vi.advanceTimersByTime(119));
    expect(document.querySelector('[data-component="marketplace-detail-modal"]')).not.toBeNull();
    await act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector('[data-component="marketplace-detail-modal"]')).toBeNull();
  });

  it('cancels a pending exit and shows the current listing when reopened', async () => {
    vi.useFakeTimers();
    render(<MarketplaceView />);

    openTrustedListing();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await act(() => vi.advanceTimersByTime(60));

    const nextCard = screen.getByText(/64 browsing sessions over 3 months/).closest('button');
    expect(nextCard).not.toBeNull();
    fireEvent.click(nextCard!);
    await act(() => vi.advanceTimersByTime(120));

    const modal = document.querySelector(
      '[data-component="marketplace-detail-modal"]',
    ) as HTMLElement;
    expect(modal).not.toBeNull();
    expect(modal).not.toHaveAttribute('aria-hidden');
    expect(modal).not.toHaveAttribute('inert');
    expect(modal).toHaveClass('animate-modal-backdrop-in');
    expect(
      within(screen.getByRole('dialog', { name: 'Profile listing details' })).getByText(
        /64 browsing sessions over 3 months/,
      ),
    ).toBeTruthy();
  });

  it('removes the modal immediately on close when reduced motion is preferred', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render(<MarketplaceView />);

    openTrustedListing();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);

    expect(document.querySelector('[data-component="marketplace-detail-modal"]')).toBeNull();
  });
});
