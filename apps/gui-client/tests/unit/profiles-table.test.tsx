// ProfilesTable — the list view rebuilt as a sortable table. Asserts the
// egress data the old list lacked (exit IP, UDP status, country, latency)
// renders, sorting headers fire onSort, row click selects, and action buttons
// act without bubbling to a select toggle.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableProps,
} from '../../src/components/ProfilesTable';
import {
  EXIT_GEO_UNAVAILABLE_SHORT,
  EXIT_GEO_UNAVAILABLE_TITLE,
} from '../../src/lib/proxy-check-copy';

// Contrast (2026-09-12) — the WCAG 2.1 ratio the gate (scripts/gui-text-quality.mjs)
// measures, from the tokens in styles/index.css, per mode.
type Rgb = readonly [number, number, number];
// Comments stripped first: the token layer's prose mentions `data-mode`, and a
// comment ABOVE a block is part of that block's selector text to the parser.
const INDEX_CSS = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
/** `--name-rgb` for a mode; THROWS when absent (a missing token must red the
 *  arm — an undefined Tailwind class renders NO colour, not a fallback). */
function modeRgb(name: string, mode: 'light' | 'dark'): Rgb {
  let fallback: Rgb | null = null;
  for (const [, selector, body] of INDEX_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const m = new RegExp(`--${name}-rgb:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(body ?? '');
    if (m === null) continue;
    const rgb: Rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (new RegExp(`data-mode=['"]${mode}['"]`).test(selector ?? '')) return rgb;
    if (!/data-mode/.test(selector ?? '')) fallback = rgb;
  }
  if (fallback === null)
    throw new Error(`--${name}-rgb is not defined for ${mode} in styles/index.css`);
  return fallback;
}
function wcagContrast(a: Rgb, b: Rgb): number {
  const lum = ([r, g, b2]: Rgb): number => {
    const lin = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b2);
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

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

  // 2026-09-24 (owner item 9) — the chips carry the word, the card's text for the
  // same reading ('UDP ✓' / '⤵ UDP'), and a proxy nothing has measured says so
  // ('— UDP'); the bare dash is left for a row with no proxy at all.
  it('UDP shows UDP ✓ (ok) / ⤵ UDP (fail) / — UDP (not measured) / – (no proxy)', () => {
    const { rerender } = render(<ProfilesTable {...props({ rows: [row({ udp: 'ok' })] })} />);
    expect(screen.getByText('UDP ✓')).toBeTruthy();
    rerender(<ProfilesTable {...props({ rows: [row({ udp: 'fail' })] })} />);
    expect(screen.getByText('⤵ UDP')).toBeTruthy();
    rerender(<ProfilesTable {...props({ rows: [row({ udp: 'unknown' })] })} />);
    expect(screen.getByText('— UDP')).toBeTruthy();
    rerender(<ProfilesTable {...props({ rows: [row({ udp: 'unknown', hasProxy: false })] })} />);
    expect(screen.getByText('–')).toBeTruthy();
    cleanup();
  });

  it('C4 — the OS row reaches the LIST: a fed fingerprint renders its chip, and an un-fed row states the card\'s absence ("— OS"), never a reading (owner item 9, 2026-09-24)', () => {
    // The owner, 2026-09-12: *"i dont see OS currently at profile grid either"* —
    // they read the list beside the grid, and `ProfileTableRow` carried no
    // `osFingerprint` field at all, so no fix to the card could reach this
    // surface. The cell uses the SHARED ProxyOsChip (components/ProxyCapabilities)
    // so the two surfaces cannot disagree about what a fingerprint means.
    // Mutations run 2026-09-12, each restored byte-exactly:
    //   • drop the `r.osFingerprint !== undefined` arm → the match arm goes red;
    //   • render the chip unconditionally, or add back a VPN fallback → the LAST
    //     TWO arms go red, which is the pair that matters: '— OS' on a row
    //     nobody passed a reading to says "we looked and found nothing", and
    //     that is false for every proxy that has a reading. An absent prop is
    //     not a measurement.
    const { rerender } = render(
      <ProfilesTable
        {...props({
          rows: [
            row({
              // (V-219) The vantage is fixture FURNITURE here, not this arm's
              // subject: the arm is about the cell reaching the list at all, and
              // it needs a reading that actually asserts to tell a rendered chip
              // from a swallowed one. `exit_ip` + single-host is the ordinary
              // datacentre SOCKS5 case — dialled host, SYN emitter and
              // destination-visible address are ONE machine, so nothing in
              // between can route a website's port differently — and it is the
              // only shape the match/mismatch arms fire on at all now.
              // ⚠️ Never 'proxy_host' beside `singleHostVantage: true`: single
              // host means the dialled address IS the exit, so the server labels
              // it 'exit_ip', and that pair would pin a state the producer never
              // emits.
              osFingerprint: {
                os: 'macos-or-ios',
                confidence: 'high',
                reason: 'SYN/TTL 64',
                observedVia: 'exit_ip',
                singleHostVantage: true,
              },
            }),
          ],
        })}
      />,
    );
    const match = document.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(match).not.toBeNull();
    expect(match?.getAttribute('data-os-tone')).toBe('match');
    expect(match?.textContent).toBe('✓iOS/macOS'); // glyph + label, gap-0.5 between
    // The one measured defect keeps its own tone here as well — carrying the
    // same single-host vantage, because (V-219) the gate withholds the RED
    // exactly as hard as the green, and this arm is not the place that pins
    // that. It is here to prove the tone reaches the list, not to prove which
    // tone a vantage earns.
    rerender(
      <ProfilesTable
        {...props({
          rows: [
            row({
              osFingerprint: {
                os: 'windows',
                confidence: 'high',
                reason: 'TTL 128',
                observedVia: 'exit_ip',
                singleHostVantage: true,
              },
            }),
          ],
        })}
      />,
    );
    expect(
      document
        .querySelector('[data-component="proxy-os-fingerprint"]')
        ?.getAttribute('data-os-tone'),
    ).toBe('mismatch');
    // ⛔ A row nobody passed a reading to renders NO chip — VPN or not. The '—'
    // placeholder says "we looked and there is no reading", which is false for
    // every proxy that HAS one, and a VPN row already states its tunnel in this
    // same cell ("UDP via tunnel"). The second chip is also not free: rendering
    // it measured +27px on the table shell and overflowed the marketing capture
    // (scripts/marketing-screens.mjs `profiles-list`, 1526px — run 2026-09-12,
    // which is how this arm got its shape).
    // (V6 2026-09-16) ITEM 3 — `udp: 'unknown'` is now explicit rather than
    // incidental: the tunnel pill is the NOT-MEASURED arm, and the factory's
    // default `udp: 'ok'` would (correctly) render a MEASURED chip instead. This
    // arm is about the OS chip, so it states the UDP state it means.
    // ⛔ 2026-09-24 (owner item 9) — REVERSED, deliberately. The row IS always
    // handed the reading the card is handed, so an absent one is the card's
    // absence, and the list now states it as the card does: the tunnel's cause on
    // a VPN row ('— OS', "not available for VPN connections"), "OS not measured
    // yet" on a SOCKS5 row — never a reading, never an empty cell. The width the
    // note above warns about is re-measured for the Network cell in the list
    // scene's fits guard (scripts/marketing-screens.mjs) and the harness.
    rerender(<ProfilesTable {...props({ rows: [row({ vpn: true, udp: 'unknown' })] })} />);
    expect(screen.getByText('⇢ UDP')).toBeTruthy();
    const vpnOs = document.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(vpnOs?.textContent).toBe('—OS');
    expect(vpnOs?.getAttribute('title')).toMatch(/not available for VPN connections/);
    rerender(<ProfilesTable {...props({ rows: [row()] })} />);
    const socksOs = document.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(socksOs?.textContent).toBe('—OS');
    expect(socksOs?.getAttribute('data-os-tone')).toBe('unknown');
    expect(socksOs?.getAttribute('title')).toBe('OS not measured yet. Run Test on this proxy.');
    // …and a row with no proxy says nothing about an OS it does not have.
    rerender(<ProfilesTable {...props({ rows: [row({ hasProxy: false })] })} />);
    expect(document.querySelector('[data-component="proxy-os-fingerprint"]')).toBeNull();
    cleanup();
  });

  it("C4/V-219 — a mismatch reading with NO single-host vantage still RENDERS on the list, as the withheld '?' tone: this cell decides PRESENCE, the shared verdict decides ASSERTION", () => {
    // ⚠️ A DELIBERATE INVERSION, not a regression. Before V-219 this exact
    // fixture — a real macOS/iOS reading carrying no vantage — rendered the
    // green '✓' chip on this surface; it no longer may. The owner measured why
    // with a third-party instrument 2026-09-14: browserleaks.com/ip loaded
    // THROUGH their residential proxy reads the arriving stack on 443, a
    // website's port, and reports Mac/iOS, while our observer reads the SAME
    // proxy on 7791 and reports Linux at high confidence. The provider routes
    // web traffic through the residential device and odd ports through its own
    // infrastructure, so a reading taken at our vantage can describe a path no
    // website ever touches. ⛔ ABSENT MEANS FALSE: a legacy cached row, an older
    // server and a tampered response all read `undefined` here, and every one of
    // them must fail to assert rather than default into a confident claim.
    //
    // ⛔ WHY IT LIVES BESIDE C4 AND NOT ONLY IN THE VERDICT'S OWN SPEC. What is
    // pinned here is not the rule — it is that this CELL hands the chip the
    // whole record and adds nothing to it. The match arm above already catches a
    // refactor that DROPS the vantage on the way through (its green would go
    // red). Only this arm catches the opposite and far worse one: a cell that
    // spreads a vantage of its own (`{...r.osFingerprint, singleHostVantage:
    // true}`) to get its green chips back leaves every other arm in this file
    // green. A false red is an irritant somebody eventually reports; a false
    // green on a detectable proxy costs a customer their account, and nobody
    // ever files a bug about a reassuring badge.
    //
    // ⛔ OWNER 2026-09-24 (item 9): "if it's a Apple, it should be green status".
    // An Apple reading is now green from every vantage, so the withheld case this
    // arm needs is the RED one: a Windows reading with no vantage must reach the
    // cell as the neutral '?', and a cell that spread a vantage of its own would
    // turn it red. (The fixture was a macOS/iOS reading until then.)
    render(
      <ProfilesTable
        {...props({
          rows: [
            row({
              osFingerprint: { os: 'windows', confidence: 'high', reason: 'SYN/TTL 128' },
            }),
          ],
        })}
      />,
    );
    const chip = document.querySelector('[data-component="proxy-os-fingerprint"]');
    // PRESENCE is unchanged, and that is the half this file owns: this client
    // HOLDS a reading, so the cell still renders one. The withheld case is a
    // quieter chip, never a missing one — which is what keeps it distinct from
    // the un-fed rows C4 asserts render nothing at all.
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-os-tone')).toBe('unknown');
    // Still one glyph plus the same label — the OS that was measured is named,
    // only the claim about it is withheld — so the cell's width budget (see the
    // ProfilesTable comment beside this column) is the same shape as the green.
    expect(chip?.textContent).toBe('?Windows');
    expect(chip?.getAttribute('title')).toContain('a website may reach a different one');
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

  it('notes: waits for persistence, suppresses duplicate commits, and keeps failures editable', async () => {
    let resolve!: (value: string | null) => void;
    const pending = new Promise<string | null>((done) => {
      resolve = done;
    });
    const onSaveNote = vi.fn(() => pending);
    render(<ProfilesTable {...props({ rows: [row({ note: '' })], onSaveNote })} />);
    fireEvent.click(screen.getByTitle('Add a note'));
    const input = screen.getByLabelText('Note for amsterdam shopper');
    fireEvent.change(input, { target: { value: '  account note  ' } });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onSaveNote).toHaveBeenCalledWith('p1', 'account note');
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect(input).toBeDisabled();

    resolve('Saved locally, but account sync failed.');
    expect(await screen.findByRole('alert')).toHaveTextContent('account sync failed');
    expect(screen.getByLabelText('Note for amsterdam shopper')).toBeTruthy();
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

  it('running row → Open session + Stop instead of Launch (Phase C / C9: the grid card\'s word for the same handler — never "Live view")', () => {
    const onWatch = vi.fn();
    render(<ProfilesTable {...props({ rows: [row({ running: true })], onWatch })} />);
    // ProfilesTable.tsx, the running row's first action: its caption is the
    // card dock's 'Open session'; restoring 'Live view' reds both arms.
    const open = screen.getByRole('button', { name: 'Open session' });
    expect(screen.queryByRole('button', { name: 'Live view' })).toBeNull();
    fireEvent.click(open);
    expect(onWatch).toHaveBeenCalledWith('p1');
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
    // never-saved profile → "—" (the storage CELL: the Network cell's '— OS'
    // chip carries a '—' glyph of its own since 2026-09-24)
    render(<ProfilesTable {...props({ rows: [row({ sizeLabel: '—' })] })} />);
    expect(
      within(screen.getByRole('table'))
        .getAllByText('—')
        .some((el) => el.tagName === 'TD'),
    ).toBe(true);
    cleanup();
  });

  it('surfaces saved-tab restore before launch without exposing encrypted tab details', () => {
    const { rerender } = render(
      <ProfilesTable {...props({ rows: [row({ savedTabsReopen: true, running: false })] })} />,
    );
    const line = screen.getByText('↻ Saved tabs reopen');
    // C3 (2026-09-12) — 10px accent TEXT wears the mode-aware token: the bare
    // accent measured 2.37 on the dark raised surface. Mutation: `text-accent`
    // back on this line → the class pin reds; a dark --accent-text-rgb that
    // does not clear 4.5 on base AND raised reds the token arm.
    const cls = line.className.split(/\s+/);
    expect(cls).toContain('text-accent-text');
    expect(cls).not.toContain('text-accent');
    for (const mode of ['light', 'dark'] as const) {
      for (const surface of ['base', 'raised'] as const) {
        expect(
          wcagContrast(modeRgb('accent-text', mode), modeRgb(`surface-${surface}`, mode)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Positive control — the class this replaced: the accent on the dark raised surface is 2.37.
    expect(wcagContrast(modeRgb('accent', 'dark'), modeRgb('surface-raised', 'dark'))).toBeLessThan(
      4.5,
    );
    expect(wcagContrast(modeRgb('accent', 'dark'), modeRgb('surface-raised', 'dark'))).toBeCloseTo(
      2.37,
      1,
    );

    rerender(
      <ProfilesTable {...props({ rows: [row({ savedTabsReopen: true, running: true })] })} />,
    );
    expect(screen.queryByText('↻ Saved tabs reopen')).toBeNull();
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

  // 2026-09-11 — the exit address never truncates. It was a shrinkable flex
  // item (`truncate` → overflow hidden → min-width 0), so the auto-layout
  // column took its width from the other rows and a WireGuard row, whose
  // wider "Check VPN" control shares the line, rendered "203.0.11…" in the
  // marketing capture. jsdom lays nothing out, so this pins the mechanism:
  // the span is shrink-0 and carries no truncation.
  it("the exit address is a shrink-0 span with no truncation — a VPN row's wider Check VPN control cannot squeeze it", () => {
    render(
      <ProfilesTable
        {...props({
          rows: [
            row({ exitIp: '203.0.113.42', vpn: true, probed: true, locationLabel: 'Zürich' }),
            row({ id: 'b', name: 'other', exitIp: '203.0.113.7' }),
          ],
        })}
      />,
    );
    const spans = document.querySelectorAll('[data-component="profile-row-exit-ip"]');
    expect(spans).toHaveLength(2);
    for (const span of Array.from(spans)) {
      expect(span.classList.contains('shrink-0')).toBe(true);
      expect(span.classList.contains('truncate')).toBe(false);
      expect(span.className).not.toMatch(/overflow-hidden|max-w-/);
    }
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

  it('Phase C (C8) — the THIRD exit state: a usable proxy whose last echo round-trip did not complete reads the SAME word as the card (EXIT_GEO_UNAVAILABLE_SHORT), titled with why — never "no exit IP" or "untested"', () => {
    // ProfilesTable.tsx exit cell, the `r.exitProbeFailed === true` arm: dropping
    // it falls through to 'no exit IP' (probed) and reds the first assertion;
    // retyping the word instead of reading the constant reds the parity arm.
    render(
      <ProfilesTable
        {...props({ rows: [row({ exitIp: null, probed: true, exitProbeFailed: true })] })}
      />,
    );
    const table = screen.getByRole('table');
    const cell = within(table).getByText(EXIT_GEO_UNAVAILABLE_SHORT);
    expect(cell.getAttribute('data-component')).toBe('profile-row-exit-probe-failed');
    expect(cell.getAttribute('title')).toBe(EXIT_GEO_UNAVAILABLE_TITLE);
    expect(within(table).queryByText('no exit IP')).toBeNull();
    expect(within(table).queryByText('untested')).toBeNull();
    // Parity: the card renders the identical word for the identical state.
    expect(EXIT_GEO_UNAVAILABLE_SHORT).toBe('exit location unknown');
    cleanup();
    // A VPN row keeps its own sentence (the tunnel state outranks the echo state).
    render(
      <ProfilesTable
        {...props({
          rows: [row({ exitIp: null, probed: true, exitProbeFailed: true, vpn: true })],
        })}
      />,
    );
    expect(within(screen.getByRole('table')).queryByText(EXIT_GEO_UNAVAILABLE_SHORT)).toBeNull();
    cleanup();
  });
});

// 2026-09-12 review — the one profiles-list finding the gate still reported.
describe('the "UDP via tunnel" chip reads in secondary ink on its divider wash', () => {
  const wash = (fg: Rgb, alpha: number, bg: Rgb): Rgb => [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];

  it('wears text-ink-secondary (6.71 dark / 5.51 light on divider/60 over raised) — muted was 3.88 in dark', () => {
    // Mutation: `text-ink-muted` back on the chip → the class pin reds, and the
    // arithmetic below shows why (the gate's own measurement: fg #94a3b8 on
    // #374357 = 3.88 at 10px, need 4.5).
    // (V6 2026-09-16) ITEM 3 — the pill renders for a VPN row with NO UDP
    // measurement, which is every VPN row until the node's three-state reading
    // lands; a MEASURED row renders the chip below it instead. Stated here so the
    // contrast pin cannot start describing a different element.
    render(<ProfilesTable {...props({ rows: [row({ vpn: true, udp: 'unknown' })] })} />);
    const chip = screen.getByText('⇢ UDP'); // "UDP via tunnel" until 2026-09-24
    expect(chip.getAttribute('data-udp')).toBe('tunnel');
    const cls = chip.className.split(/\s+/);
    expect(cls).toContain('text-ink-secondary');
    expect(cls).not.toContain('text-ink-muted');
    expect(cls).toContain('bg-surface-divider/60');
    for (const mode of ['light', 'dark'] as const) {
      const bg = wash(modeRgb('surface-divider', mode), 0.6, modeRgb('surface-raised', mode));
      expect(wcagContrast(modeRgb('ink-secondary', mode), bg), mode).toBeGreaterThanOrEqual(4.5);
    }
    // Positive control — the ink this replaced, on the same wash, in dark.
    const darkWash = wash(
      modeRgb('surface-divider', 'dark'),
      0.6,
      modeRgb('surface-raised', 'dark'),
    );
    expect(wcagContrast(modeRgb('ink-muted', 'dark'), darkWash)).toBeLessThan(4.5);
    expect(wcagContrast(modeRgb('ink-muted', 'dark'), darkWash)).toBeCloseTo(3.88, 1);
    cleanup();
  });
});
