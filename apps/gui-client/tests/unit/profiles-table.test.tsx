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
    sizeLabel: '4.2 MiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
    lastUsedIso: null,
    selected: false,
    busy: false,
    launching: false,
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
    onTrim: vi.fn(),
    onDelete: vi.fn(),
    onSaveNote: vi.fn(),
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

  it('notes: empty cell shows "+ note", clicking opens an editor, Enter commits via onSaveNote (trimmed), and editing does not toggle row select', () => {
    const onSaveNote = vi.fn();
    const onToggleSelect = vi.fn();
    render(<ProfilesTable {...props({ rows: [row({ note: '' })], onSaveNote, onToggleSelect })} />);
    fireEvent.click(screen.getByTitle('Add a note'));
    const input = screen.getByLabelText('Note for amsterdam shopper');
    fireEvent.change(input, { target: { value: '  aged 30d  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSaveNote).toHaveBeenCalledWith('p1', 'aged 30d'); // trimmed
    expect(onToggleSelect).not.toHaveBeenCalled(); // cell stops propagation
    cleanup();
  });

  it('notes: an existing note renders clickable for editing', () => {
    render(<ProfilesTable {...props({ rows: [row({ note: 'vip buyer' })] })} />);
    fireEvent.click(screen.getByTitle('Click to edit note'));
    expect(screen.getByLabelText('Select amsterdam shopper')).toBeTruthy();
    expect(screen.getByLabelText('Note for amsterdam shopper').value).toBe('vip buyer');
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

  it('shows an inline, accessible spinner only while the row is launching', () => {
    const { container, rerender } = render(
      <ProfilesTable {...props({ rows: [row({ busy: true, launching: true })] })} />,
    );
    const launching = screen.getByRole('button', { name: 'Launching…' });
    expect(launching).toBeDisabled();
    expect(launching).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-component="launch-spinner"]')).not.toBeNull();

    rerender(<ProfilesTable {...props({ rows: [row({ busy: true, launching: false })] })} />);
    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Launch' })).toHaveAttribute('aria-busy', 'false');
    expect(container.querySelector('[data-component="launch-spinner"]')).toBeNull();
    cleanup();
  });

  it('worktimer: a running row with a known start time shows a live elapsed; idle/unknown shows none', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(
      <ProfilesTable {...props({ rows: [row({ running: true, runningSinceIso: fiveMinAgo })] })} />,
    );
    expect(screen.getByText(/^\d+m$/)).toBeTruthy(); // "5m" (minute-granular elapsed)
    cleanup();
    // idle row → no elapsed
    render(
      <ProfilesTable {...props({ rows: [row({ running: false, runningSinceIso: null })] })} />,
    );
    expect(screen.queryByText(/^\d+m$/)).toBeNull();
    cleanup();
  });

  it('renders the per-profile storage size (doc-150 item 5)', () => {
    render(<ProfilesTable {...props({ rows: [row({ sizeLabel: '18.7 MiB' })] })} />);
    expect(within(screen.getByRole('table')).getByText('18.7 MiB')).toBeTruthy();
    cleanup();
    // never-saved profile → "—"
    render(<ProfilesTable {...props({ rows: [row({ sizeLabel: '—' })] })} />);
    expect(within(screen.getByRole('table')).getByText('—')).toBeTruthy();
    cleanup();
  });

  it('Trim button ("Clear cache, keep logins") fires onTrim without toggling row select', () => {
    const onTrim = vi.fn();
    const onToggleSelect = vi.fn();
    render(<ProfilesTable {...props({ onTrim, onToggleSelect })} />);
    const trim = screen.getByRole('button', { name: 'Trim' });
    expect(trim.getAttribute('title')).toBe('Clear cache, keep logins');
    fireEvent.click(trim);
    expect(onTrim).toHaveBeenCalledWith('p1');
    expect(onToggleSelect).not.toHaveBeenCalled(); // stopPropagation
    cleanup();
  });

  it('Trim is disabled while the row is busy', () => {
    render(<ProfilesTable {...props({ rows: [row({ busy: true })] })} />);
    expect(screen.getByRole('button', { name: 'Trim' })).toBeDisabled();
    cleanup();
  });

  it('Delete/Trim/Duplicate on an IDLE row are disabled (with a hint) while ANOTHER profile is busy', () => {
    // The mutate handlers early-return on a global busyId; without this the
    // buttons stay enabled and a click silently no-ops (founder thinks it missed).
    render(
      <ProfilesTable
        {...props({ anyBusy: true, onClone: vi.fn(), rows: [row({ id: 'p1', busy: false })] })}
      />,
    );
    const del = screen.getByRole('button', { name: 'Delete' });
    const trim = screen.getByRole('button', { name: 'Trim' });
    const dup = screen.getByRole('button', { name: 'Duplicate' });
    expect(del).toBeDisabled();
    expect(trim).toBeDisabled();
    expect(dup).toBeDisabled();
    // The hint explains WHY (so it isn't a mystery dead button).
    expect(del.getAttribute('title')).toMatch(/Another profile is busy/i);
    expect(trim.getAttribute('title')).toMatch(/Another profile is busy/i);
    expect(dup.getAttribute('title')).toMatch(/Another profile is busy/i);
    cleanup();
  });

  it('anyBusy leaves THIS row’s mutate actions live when it is the busy row (its own busy guard governs)', () => {
    // The busy ROW itself shows its own busy state; anyBusy only gates OTHER rows.
    // Here the single row IS the busy one, so otherBusy is false and the normal
    // per-row busy disabling applies (Trim disabled by r.busy, not by the hint).
    render(
      <ProfilesTable
        {...props({ anyBusy: true, onClone: vi.fn(), rows: [row({ id: 'p1', busy: true })] })}
      />,
    );
    const trim = screen.getByRole('button', { name: 'Trim' });
    expect(trim).toBeDisabled(); // disabled by its own busy, not the other-busy hint
    expect(trim.getAttribute('title')).toBe('Clear cache, keep logins');
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
