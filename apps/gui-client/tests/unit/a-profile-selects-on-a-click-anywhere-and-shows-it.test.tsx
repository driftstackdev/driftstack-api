// T-19 — owner #5: "The profiles selection, at tab Profiles is only still a
// small checkbox to select it … it should be able to select easier".
//
// Whole-row (table) and whole-card (grid) click-to-select has existed since
// 0.1.0. What the owner met was that nothing showed it:
//   - the table's Notes <td> stopped click propagation for its whole column, so
//     the row's real select target was narrower than the row it painted;
//   - the grid card's selection ring was opacity-0 until hovered, so an
//     unselected card showed no affordance at all;
//   - nothing anywhere said "click to select".
//
// These arms pin the fix at both production sites. The read of the ask is
// DISCOVERABILITY, not a new model: selection stays the multi-select Set that
// ProfilesActionBar and every bulk action read, so a single-select-to-launch
// model was deliberately not introduced.
//
// Mutations that must turn this file red (each planted and reverted 2026-09-07):
//   - restore `onClick={(e) => e.stopPropagation()}` on the Notes <td>
//     → "clicking the Notes cell beside its control selects the row";
//   - restore `opacity-0 group-hover:opacity-100` on the unselected indicator
//     → "unselected: a hollow ring with no opacity-0";
//   - drop `border-l-accent` from the selected row branch
//     → "a selected row carries the accent rail";
//   - drop `border-l-2` from the <tr> base class (a colour on a 0px border is
//     no rail) → "a selected row carries the accent rail";
//   - drop the stopPropagation from the open note editor's wrapper <div>
//     → "while the note editor is open, a click on the editor beside its input".

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableProps,
} from '../../src/components/ProfilesTable';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';

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

function tableProps(over: Partial<ProfilesTableProps> = {}): ProfilesTableProps {
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
    onEdit: vi.fn(),
    onTrim: vi.fn(),
    onDelete: vi.fn(),
    onSaveNote: vi.fn(),
    ...over,
  };
}

function cardProps(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: 'amsterdam shopper',
    monogram: 'AS',
    hue: 200,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: null,
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    latencyMs: 42,
    latencyFillPct: 30,
    latencyGood: true,
    probed: true,
    capabilities: {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 42,
      message: 'ok',
    },
    checkedAtIso: null,
    busy: false,
    launching: false,
    anyBusy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onTest: vi.fn(),
    ...over,
  };
}

const rowOf = (name: string): HTMLElement => {
  const tr = screen.getByText(name).closest('tr');
  if (tr === null) throw new Error(`no <tr> around "${name}"`);
  return tr;
};

describe('ProfilesTable — the whole row is the select target, and says so (T-19)', () => {
  it('clicking the Notes cell beside its control selects the row — the cell no longer swallows the column', () => {
    const onToggleSelect = vi.fn();
    render(<ProfilesTable {...tableProps({ rows: [row({ note: '' })], onToggleSelect })} />);
    const cell = screen.getByTitle('Add a note').closest('td');
    expect(cell, 'the Notes cell is in the DOM').not.toBeNull();
    fireEvent.click(cell as HTMLElement);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledWith('p1');
    cleanup();

    // Same cell, with a note already on the row.
    const onToggleSelect2 = vi.fn();
    render(
      <ProfilesTable
        {...tableProps({ rows: [row({ note: 'vip buyer' })], onToggleSelect: onToggleSelect2 })}
      />,
    );
    fireEvent.click(screen.getByTitle('Click to edit note').closest('td') as HTMLElement);
    expect(onToggleSelect2).toHaveBeenCalledTimes(1);
  });

  it('control: the editor controls in that same cell still do NOT select — "+ note", the input, an existing note', () => {
    const onToggleSelect = vi.fn();
    render(<ProfilesTable {...tableProps({ rows: [row({ note: '' })], onToggleSelect })} />);
    fireEvent.click(screen.getByTitle('Add a note'));
    const input = screen.getByLabelText('Note for amsterdam shopper');
    fireEvent.click(input);
    expect(onToggleSelect).not.toHaveBeenCalled();
    cleanup();

    render(
      <ProfilesTable {...tableProps({ rows: [row({ note: 'vip buyer' })], onToggleSelect })} />,
    );
    fireEvent.click(screen.getByTitle('Click to edit note'));
    expect(screen.getByLabelText('Note for amsterdam shopper')).toBeTruthy(); // the editor opened
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('while the note editor is open, a click on the editor beside its input — the wrapper, the error text — does not select', async () => {
    const onToggleSelect = vi.fn();
    const onSaveNote = vi.fn().mockResolvedValue('Note could not be saved');
    render(
      <ProfilesTable {...tableProps({ rows: [row({ note: '' })], onToggleSelect, onSaveNote })} />,
    );
    fireEvent.click(screen.getByTitle('Add a note'));
    const input = screen.getByLabelText('Note for amsterdam shopper');
    const editor = input.parentElement as HTMLElement;
    expect(editor.tagName, 'the editor wrapper is the div around the input, not the cell').toBe(
      'DIV',
    );
    fireEvent.click(editor);
    expect(onToggleSelect).not.toHaveBeenCalled();
    // Blur commits; the save fails, so the error text is now a click target
    // beside the input — a click there must not commit AND flip selection.
    fireEvent.blur(input);
    const alert = await screen.findByRole('alert');
    expect(editor.contains(alert)).toBe(true);
    fireEvent.click(alert);
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
    // Vacuity control: same mock, same row, editor closed — a click on the cell
    // selects, so "not called" above was a live handler declining, not an
    // unwired one.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Note for amsterdam shopper')).toBeNull();
    fireEvent.click(screen.getByTitle('Add a note').closest('td') as HTMLElement);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('every cell in the row selects; every control inside them acts without selecting (no container cell stops propagation)', () => {
    const onToggleSelect = vi.fn();
    const onTest = vi.fn();
    const onEdit = vi.fn();
    render(
      <ProfilesTable
        {...tableProps({ rows: [row({ note: 'vip buyer' })], onToggleSelect, onTest, onEdit })}
      />,
    );
    const cells = Array.from(rowOf('amsterdam shopper').querySelectorAll('td'));
    // select · Profile · Tags · Status · Exit IP · UDP · Created · Last used ·
    // Storage · Notes · Actions — if a column is added this still counts them all.
    expect(cells.length, 'the row has its cells').toBeGreaterThanOrEqual(11);
    for (const td of cells) fireEvent.click(td);
    expect(onToggleSelect).toHaveBeenCalledTimes(cells.length);

    // Control arm: the real controls inside those cells act without selecting.
    const selectsSoFar = onToggleSelect.mock.calls.length;
    fireEvent.click(screen.getByTitle(/Test proxy/));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText('Select amsterdam shopper'));
    expect(onTest).toHaveBeenCalledWith('p1');
    expect(onEdit).toHaveBeenCalledWith('p1');
    // The checkbox is a control too: it selects through onChange (once), never
    // twice through the row.
    expect(onToggleSelect).toHaveBeenCalledTimes(selectsSoFar + 1);
  });

  it('a selected row carries the accent rail and tint; the row beside it does not; the checkbox stays for assistive tech', () => {
    render(
      <ProfilesTable
        {...tableProps({
          rows: [
            row({ id: 'p1', name: 'first', selected: true }),
            row({ id: 'p2', name: 'second', selected: false }),
          ],
        })}
      />,
    );
    const first = rowOf('first');
    const second = rowOf('second');
    expect(first.classList.contains('border-l-accent')).toBe(true);
    expect(first.classList.contains('bg-accent-subtle')).toBe(true);
    expect(second.classList.contains('border-l-accent')).toBe(false);
    expect(second.classList.contains('bg-accent-subtle')).toBe(false);
    // The rail's width is reserved on every row, so selecting shifts nothing.
    expect(second.classList.contains('border-l-transparent')).toBe(true);
    // The rail's WIDTH is its own class: `border-l-accent` on a 0px border
    // paints nothing, so the width is pinned too, on both rows.
    expect(first.classList.contains('border-l-2')).toBe(true);
    expect(second.classList.contains('border-l-2')).toBe(true);
    // Control: the header row has no rail, so `border-l-2` is a class the body
    // rows earn, not one this query would find on any <tr>.
    const header = first.closest('table')?.querySelector('thead tr') ?? null;
    expect(header, 'the header row').not.toBeNull();
    expect((header as HTMLElement).classList.contains('border-l-2')).toBe(false);
    expect(second.className).toMatch(/hover:bg-surface-elevated/);
    // The last-row border reset must clear the bottom rule only — `last:border-0`
    // erased the rail on the last row.
    expect(second.className).not.toMatch(/(^|\s)last:border-0(\s|$)/);
    expect(second.className).toMatch(/(^|\s)last:border-b-0(\s|$)/);
    expect(screen.getByLabelText<HTMLInputElement>('Select first').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Select second').checked).toBe(false);
  });

  it('vacuity: with nothing selected no row carries the rail — the class is earned by selection, not painted on every row', () => {
    const { container } = render(
      <ProfilesTable
        {...tableProps({
          rows: [row({ id: 'p1', name: 'first' }), row({ id: 'p2', name: 'second' })],
        })}
      />,
    );
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
    expect(container.querySelectorAll('tbody tr.border-l-accent').length).toBe(0);
    expect(container.querySelectorAll('tbody tr.bg-accent-subtle').length).toBe(0);
  });

  it('the name cell says what a click does, in both states', () => {
    const { rerender } = render(<ProfilesTable {...tableProps({ rows: [row()] })} />);
    expect(screen.getByTitle('Click to select').closest('tr')).toBe(rowOf('amsterdam shopper'));
    rerender(<ProfilesTable {...tableProps({ rows: [row({ selected: true })] })} />);
    expect(screen.getByTitle('Selected — click to deselect').closest('tr')).toBe(
      rowOf('amsterdam shopper'),
    );
    expect(screen.queryByTitle('Click to select')).toBeNull();
  });
});

describe('ProfilePhoneCard — the selection indicator is visible before hover (T-19)', () => {
  const indicator = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector('[data-component="select-indicator"]');
    if (el === null) throw new Error('no select indicator on the card');
    return el as HTMLElement;
  };

  it('unselected: a hollow ring with no opacity-0 and no hover-only reveal, titled so it says what a click does', () => {
    const { container } = render(<ProfilePhoneCard {...cardProps({ selected: false })} />);
    const ring = indicator(container);
    // classList membership, not a substring match: `opacity-100` would not match
    // /opacity-0/ but a future `opacity-0/50` style token could, and the old
    // string also carried `group-hover:opacity-100`.
    expect(ring.classList.contains('opacity-0')).toBe(false);
    expect(ring.className).not.toMatch(/group-hover:opacity-100/);
    expect(ring.classList.contains('rounded-full'), 'the element we mean').toBe(true);
    expect(ring.className, 'a hollow ring').toMatch(/(^|\s)border-\[1\.5px\]|(^|\s)border(\s|$)/);
    expect(ring.classList.contains('bg-accent')).toBe(false);
    // The tooltip is the one place on the card that says what a click does, so
    // the ring must take pointer events for the tooltip to show.
    expect(ring.classList.contains('pointer-events-none')).toBe(false);
    expect(ring.getAttribute('title')).toBe('Click to select');

    // Vacuity control: the actions menu on the SAME card still hides with
    // opacity-0 while closed, so "no opacity-0" above is a property of the
    // indicator and not of a query that could never see the class. (Phase C
    // portals the menu to document.body, so it is queried on the document.)
    const menu = document.querySelector('[data-component="card-actions-menu"]');
    expect(menu, 'the vacuity control needs the menu node').not.toBeNull();
    expect(menu?.classList.contains('opacity-0')).toBe(true);
  });

  it('selected: the filled accent check, titled for deselect; the card stays a pressed button', () => {
    const { container } = render(<ProfilePhoneCard {...cardProps({ selected: true })} />);
    const ring = indicator(container);
    expect(ring.classList.contains('bg-accent')).toBe(true);
    expect(ring.classList.contains('opacity-0')).toBe(false);
    expect(ring.getAttribute('title')).toBe('Selected — click to deselect');
    const card = screen.getByRole('button', { name: 'Select amsterdam shopper' });
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking the indicator selects (it is part of the card, not a dead spot); Enter and Space still select; Launch still does not', () => {
    const onToggleSelect = vi.fn();
    const onPrimary = vi.fn();
    const { container } = render(
      <ProfilePhoneCard {...cardProps({ onToggleSelect, onPrimary })} />,
    );
    fireEvent.click(indicator(container));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    const card = screen.getByRole('button', { name: 'Select amsterdam shopper' });
    expect(card.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onToggleSelect).toHaveBeenCalledTimes(3);
    // Control arm: a real control on the card acts without selecting.
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(3);
  });
});
