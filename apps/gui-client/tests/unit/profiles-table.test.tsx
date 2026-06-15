// ProfilesTable — the list view rebuilt as a sortable table. Asserts the
// egress data the old list lacked (exit IP, UDP status, country, latency)
// renders, sorting headers fire onSort, row click selects, and action buttons
// act without bubbling to a select toggle.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableProps,
} from '../../src/components/ProfilesTable';

function row(over: Partial<ProfileTableRow> = {}): ProfileTableRow {
  return {
    id: 'p1',
    name: 'amsterdam shopper',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    proxyAddress: '127.0.0.1:24000',
    locationLabel: 'Netherlands',
    probed: true,
    udp: 'ok',
    latencyMs: 42,
    folder: 'Shopping',
    tags: ['aged'],
    note: '',
    createdAtIso: '2026-06-01T00:00:00.000Z',
    lastUsedIso: null,
    selected: false,
    busy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    ...over,
  };
}

function props(over: Partial<ProfilesTableProps> = {}): ProfilesTableProps {
  return {
    rows: [row()],
    sortKey: 'name',
    sortDir: 'asc',
    onSort: vi.fn(),
    allSelected: false,
    onToggleSelectAll: vi.fn(),
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onStop: vi.fn(),
    onTest: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

describe('ProfilesTable', () => {
  it('renders the egress columns the old list lacked: location, exit IP, UDP, latency', () => {
    render(<ProfilesTable {...props()} />);
    expect(screen.getByText('amsterdam shopper')).toBeTruthy();
    expect(screen.getByText(/iPhone 17/)).toBeTruthy(); // device subtitle (incl. folder)
    expect(screen.getByText(/📁 Shopping/)).toBeTruthy(); // folder folded into subtitle
    expect(screen.getByText('Netherlands')).toBeTruthy(); // location in exit IP cell
    expect(screen.getByText('82.14.220.9')).toBeTruthy();
    expect(screen.getByText('42ms')).toBeTruthy(); // latency now in the exit IP cell
    expect(screen.getByText('aged')).toBeTruthy(); // tags column
    expect(screen.getByText('Idle')).toBeTruthy();
    cleanup();
  });

  it('UDP shows ✓ (ok) / ✗ (fail) / – (unknown)', () => {
    const { rerender } = render(<ProfilesTable {...props({ rows: [row({ udp: 'ok' })] })} />);
    expect(screen.getByText('✓')).toBeTruthy();
    rerender(<ProfilesTable {...props({ rows: [row({ udp: 'fail' })] })} />);
    expect(screen.getByText('✗')).toBeTruthy();
    rerender(<ProfilesTable {...props({ rows: [row({ udp: 'unknown' })] })} />);
    expect(screen.getByText('–')).toBeTruthy();
    cleanup();
  });

  it('clicking a sortable header fires onSort with its key', () => {
    const onSort = vi.fn();
    render(<ProfilesTable {...props({ onSort })} />);
    fireEvent.click(screen.getByRole('button', { name: /Created/i }));
    expect(onSort).toHaveBeenCalledWith('created');
    cleanup();
  });

  it('checkbox column: row checkbox + header select-all are keyboard-accessible and fire handlers', () => {
    const onToggleSelect = vi.fn();
    const onToggleSelectAll = vi.fn();
    render(<ProfilesTable {...props({ onToggleSelect, onToggleSelectAll })} />);
    fireEvent.click(screen.getByLabelText('Select amsterdam shopper'));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Select all profiles'));
    expect(onToggleSelectAll).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('row click selects; Launch + Delete act without bubbling to a select toggle', () => {
    const onToggleSelect = vi.fn();
    const onPrimary = vi.fn();
    const onDelete = vi.fn();
    render(<ProfilesTable {...props({ onToggleSelect, onPrimary, onDelete })} />);
    fireEvent.click(screen.getByText('amsterdam shopper'));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1); // buttons stopPropagation
    cleanup();
  });

  it('running row → Live view + Stop instead of Launch', () => {
    render(<ProfilesTable {...props({ rows: [row({ running: true })] })} />);
    expect(screen.getByRole('button', { name: 'Live view' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    cleanup();
  });

  it('no proxy → "no proxy"; never-probed → "untested"; probed-but-no-IP → "no exit IP"', () => {
    render(
      <ProfilesTable
        {...props({ rows: [row({ hasProxy: false, countryCode: null, exitIp: null })] })}
      />,
    );
    expect(screen.getByText('no proxy')).toBeTruthy();
    cleanup();
    render(<ProfilesTable {...props({ rows: [row({ exitIp: null, probed: false })] })} />);
    expect(within(screen.getByRole('table')).getByText('untested')).toBeTruthy();
    cleanup();
    // probed but the echo endpoint returned no IP — don't re-prompt a test.
    render(<ProfilesTable {...props({ rows: [row({ exitIp: null, probed: true })] })} />);
    expect(within(screen.getByRole('table')).getByText('no exit IP')).toBeTruthy();
    cleanup();
  });
});
