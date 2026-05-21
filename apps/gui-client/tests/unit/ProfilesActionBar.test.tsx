// 2026-05-21 — ProfilesActionBar (Slice B) presentation contract.
//
// Locks the search / status-segmented / sort-dropdown shape so the
// filter-and-sort UX stays accessible by name when other slices land
// (header refactor, search keyboard shortcut, etc.).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProfilesActionBar } from '../../src/components/ProfilesActionBar';

afterEach(() => cleanup());

function renderBar(props: Partial<React.ComponentProps<typeof ProfilesActionBar>> = {}) {
  const defaults: React.ComponentProps<typeof ProfilesActionBar> = {
    searchQuery: '',
    onSearchChange: vi.fn(),
    statusFilter: 'all',
    onStatusFilterChange: vi.fn(),
    sortBy: 'last-used',
    onSortByChange: vi.fn(),
    visibleCount: 5,
    totalCount: 5,
  };
  return {
    props: { ...defaults, ...props },
    ...render(<ProfilesActionBar {...defaults} {...props} />),
  };
}

describe('ProfilesActionBar', () => {
  it('renders search input + status segmented control + sort dropdown', () => {
    renderBar();
    expect(screen.getByLabelText('Search profiles')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Running' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Idle' })).toBeInTheDocument();
    expect(screen.getByLabelText('Sort profiles')).toBeInTheDocument();
  });

  it('calls onSearchChange when typing in the search input', () => {
    const onSearchChange = vi.fn();
    renderBar({ onSearchChange });
    fireEvent.change(screen.getByLabelText('Search profiles'), { target: { value: 'shopify' } });
    expect(onSearchChange).toHaveBeenCalledWith('shopify');
  });

  it('shows a Clear-search button only when there is a query', () => {
    const onSearchChange = vi.fn();
    const { rerender, props } = renderBar({ searchQuery: '', onSearchChange });
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();

    rerender(<ProfilesActionBar {...props} searchQuery="x" />);
    const clearBtn = screen.getByLabelText('Clear search');
    clearBtn.click();
    expect(onSearchChange).toHaveBeenCalledWith('');
  });

  it('marks the currently-selected status filter as aria-checked', () => {
    renderBar({ statusFilter: 'running' });
    expect(screen.getByRole('radio', { name: 'Running' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Idle' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onStatusFilterChange when a segment is clicked', () => {
    const onStatusFilterChange = vi.fn();
    renderBar({ onStatusFilterChange });
    screen.getByRole('radio', { name: 'Idle' }).click();
    expect(onStatusFilterChange).toHaveBeenCalledWith('idle');
  });

  it('calls onSortByChange when the sort dropdown changes', () => {
    const onSortByChange = vi.fn();
    renderBar({ onSortByChange });
    fireEvent.change(screen.getByLabelText('Sort profiles'), { target: { value: 'name' } });
    expect(onSortByChange).toHaveBeenCalledWith('name');
  });

  it('shows total count when no filter is active', () => {
    renderBar({ visibleCount: 5, totalCount: 5, statusFilter: 'all', searchQuery: '' });
    expect(screen.getByText(/5 profiles/)).toBeInTheDocument();
  });

  it('shows visible/total when a filter is active (status)', () => {
    renderBar({ visibleCount: 2, totalCount: 5, statusFilter: 'running', searchQuery: '' });
    expect(screen.getByText(/2 of 5/)).toBeInTheDocument();
  });

  it('shows visible/total when a filter is active (search)', () => {
    renderBar({ visibleCount: 1, totalCount: 5, statusFilter: 'all', searchQuery: 'foo' });
    expect(screen.getByText(/1 of 5/)).toBeInTheDocument();
  });

  it('uses singular "profile" for totalCount === 1', () => {
    renderBar({ visibleCount: 1, totalCount: 1 });
    expect(screen.getByText(/1 profile/)).toBeInTheDocument();
    expect(screen.queryByText(/1 profiles/)).not.toBeInTheDocument();
  });
});
