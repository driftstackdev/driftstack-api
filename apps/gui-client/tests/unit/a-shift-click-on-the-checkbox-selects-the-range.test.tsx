// (q) Item 4 — mass-select proxies: shift+click on the CHECKBOX selects the range.
//
// MEASURED (re-verification against b65ddc209): click the checkbox of row A,
// then SHIFT+click the checkbox of row E — only A and E ended up selected, not
// A..E. The row's own click handler returns early for a click that lands on an
// `input` (so Test/Edit/the checkbox keep their native behaviour), and the
// checkbox's `onChange={() => onToggle(false)}` DISCARDED the modifier — so the
// range worked only when the shift-click happened to land on the row body.
// React drives a checkbox's onChange from the native click, so the modifier is
// on `e.nativeEvent`; the handler reads it now.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARM 1: the row checkbox's
//    `onChange={(e) => onToggle((e.nativeEvent as MouseEvent).shiftKey === true)}`
//    in ProxyRow. Put `onToggle(false)` back and the shift-click selects only the
//    clicked row → the range assertion reds.
// ⛔ Widen it — `onToggle(true)` unconditionally — and the CONTROL (arm 2) reds:
//    a plain click on a third row would range-select from the anchor instead of
//    toggling one row.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

let stored: ProxyConfig[] = [];

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  setProxyServerId: vi.fn(() => Promise.resolve(null)),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'x' })),
  createProxy: vi.fn(() => Promise.resolve({ id: 'x' })),
  testAccountProxy: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  subscribeProbeCache: () => () => undefined,
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings: { apiKey: null, baseUrl: 'http://x' } }),
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

function row(n: number): ProxyConfig {
  return {
    id: `p${String(n)}`,
    label: `row-${String(n)}`,
    host: `10.0.0.${String(n)}`,
    port: 1080,
    username: null,
    password: null,
    // Distinct, ascending stamps so the default sort is stable and known.
    createdAt: `2026-07-0${String(n)}T00:00:00.000Z`,
    scheme: 'socks5',
  };
}

function box(n: number): HTMLInputElement {
  const el = screen.getByLabelText(`Select row-${String(n)}`);
  if (!(el instanceof HTMLInputElement)) throw new Error('not an input');
  return el;
}

function checkedRows(): string[] {
  return [1, 2, 3, 4, 5].filter((n) => box(n).checked).map((n) => `row-${String(n)}`);
}

beforeEach(() => {
  stored = [1, 2, 3, 4, 5].map(row);
});

describe('(q) Item 4 — shift+click on a proxy checkbox', () => {
  it('ARM 1 — CRITICAL: checkbox A, then SHIFT+checkbox E, selects A..E — not only A and E', async () => {
    render(<ProxiesView />);
    await screen.findByLabelText('Select row-1');
    fireEvent.click(box(1));
    await waitFor(() => expect(box(1).checked).toBe(true));
    fireEvent.click(box(5), { shiftKey: true });
    await waitFor(() => expect(box(5).checked).toBe(true));
    expect(checkedRows()).toEqual(['row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
  });

  it('ARM 2 — CONTROL: a plain click on the checkbox still toggles ONE row (no range from the anchor)', async () => {
    render(<ProxiesView />);
    await screen.findByLabelText('Select row-1');
    fireEvent.click(box(1));
    await waitFor(() => expect(box(1).checked).toBe(true));
    fireEvent.click(box(4)); // no modifier
    await waitFor(() => expect(box(4).checked).toBe(true));
    expect(checkedRows()).toEqual(['row-1', 'row-4']);
    // …and a plain click on a selected box deselects only it.
    fireEvent.click(box(1));
    await waitFor(() => expect(box(1).checked).toBe(false));
    expect(checkedRows()).toEqual(['row-4']);
  });

  it('ARM 3 — the range runs the other way too (E first, then SHIFT+B selects B..E)', async () => {
    render(<ProxiesView />);
    await screen.findByLabelText('Select row-1');
    fireEvent.click(box(5));
    await waitFor(() => expect(box(5).checked).toBe(true));
    fireEvent.click(box(2), { shiftKey: true });
    await waitFor(() => expect(box(2).checked).toBe(true));
    expect(checkedRows()).toEqual(['row-2', 'row-3', 'row-4', 'row-5']);
  });

  it('ARM 4 — the checkbox click does not ALSO toggle through the row handler (no double toggle)', async () => {
    // The row handler returns early for a click on an input; if that guard went,
    // one click would toggle twice and the box would read unchecked again.
    render(<ProxiesView />);
    await screen.findByLabelText('Select row-1');
    fireEvent.click(box(3));
    await waitFor(() => expect(box(3).checked).toBe(true));
    expect(checkedRows()).toEqual(['row-3']);
  });

  it('ARM 5 — polish: shift-clicking across rows must not smear a text selection (rows are select-none), and the header box is the same 16px target', async () => {
    render(<ProxiesView />);
    const b = await screen.findByLabelText('Select row-1');
    const tr = b.closest('tr');
    expect(tr?.className).toMatch(/\bselect-none\b/);
    const header = screen.getByLabelText('Select all proxies');
    expect(header.className).toMatch(/\bh-4\b/);
    expect(header.className).toMatch(/\bw-4\b/);
  });
});
