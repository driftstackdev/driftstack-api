// Tag filter rail (G3, 2026-06-14) — founder "missing tags". A row of #tag·count
// pills below the folder shelf that filters the grid by a tag. Tests the
// presentational contract: renders a pill per tag, toggles selection (clicking
// the active one clears), exposes a "clear" affordance only when a tag is
// active, and renders nothing when there are no tags (so it never adds empty
// chrome).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TagFilterRail } from '../../src/views/ProfilesView';

const TAGS = [
  { tag: 'shop', count: 3 },
  { tag: 'eu', count: 2 },
];

describe('TagFilterRail', () => {
  it('renders nothing when there are no tags', () => {
    const { container } = render(<TagFilterRail tags={[]} active={null} onSelect={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    cleanup();
  });

  it('renders a pill (label + count) per tag', () => {
    render(<TagFilterRail tags={TAGS} active={null} onSelect={vi.fn()} />);
    expect(screen.getByText('shop')).toBeTruthy();
    expect(screen.getByText('eu')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    // No "clear" affordance when nothing is active.
    expect(screen.queryByText('clear')).toBeNull();
    cleanup();
  });

  it('selecting an inactive tag calls onSelect with that tag', () => {
    const onSelect = vi.fn();
    render(<TagFilterRail tags={TAGS} active={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('shop'));
    expect(onSelect).toHaveBeenCalledWith('shop');
    cleanup();
  });

  it('clicking the ACTIVE tag clears the filter (onSelect null), and "clear" is shown', () => {
    const onSelect = vi.fn();
    render(<TagFilterRail tags={TAGS} active="shop" onSelect={onSelect} />);
    // The active pill is marked pressed.
    const shop = screen.getByText('shop').closest('button');
    expect(shop?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('shop'));
    expect(onSelect).toHaveBeenCalledWith(null);
    // The "clear" affordance also resets.
    fireEvent.click(screen.getByText('clear'));
    expect(onSelect).toHaveBeenCalledWith(null);
    cleanup();
  });
});
