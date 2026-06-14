// ProfilesEmpty (5→10 polish) — the profile grid/list empty state. Asserts it
// distinguishes "filtered to zero" (offers a Clear-filters action that fires
// onClear) from "genuinely empty" (no action), so the new tag/folder filters
// (G3) can't strand the user with no way back.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ProfilesEmpty } from '../../src/views/ProfilesView';

describe('ProfilesEmpty', () => {
  it('filtered-to-zero: shows the filter headline + a working Clear filters action', () => {
    const onClear = vi.fn();
    render(<ProfilesEmpty hasActiveFilters onClear={onClear} />);
    expect(screen.getByText('No profiles match these filters')).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Clear filters' });
    fireEvent.click(btn);
    expect(onClear).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('genuinely empty: shows the welcome headline and NO clear action', () => {
    render(<ProfilesEmpty hasActiveFilters={false} onClear={vi.fn()} />);
    expect(screen.getByText('No profiles here yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    cleanup();
  });
});
