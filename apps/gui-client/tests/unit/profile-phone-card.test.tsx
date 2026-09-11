// GX ProfilePhoneCard — the phone-framed grid card. Asserts the core data shows
// (name, device, exit IP / untested prompt), status (Live/Idle), folder/tag
// pills, and that the dock actions + selection fire their handlers.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import { STATES } from '../../src/visual-harness/gallery';

function props(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
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

describe('ProfilePhoneCard', () => {
  it('keeps the note editor mounted and single-flight until persistence succeeds', async () => {
    let resolve!: (value: string | null) => void;
    const pending = new Promise<string | null>((done) => {
      resolve = done;
    });
    const onSaveNote = vi.fn(() => pending);
    render(<ProfilePhoneCard {...props({ note: '', onSaveNote })} />);
    fireEvent.click(screen.getByLabelText('Edit note for amsterdam shopper'));
    const input = screen.getByLabelText('Note for amsterdam shopper');
    fireEvent.change(input, { target: { value: '  priority  ' } });
    const save = screen.getByRole('button', { name: 'Save' });

    act(() => {
      save.click();
      save.click();
    });
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onSaveNote).toHaveBeenCalledWith('priority');
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Note for amsterdam shopper')).toBeDisabled();

    resolve(null);
    await waitFor(() => expect(screen.queryByLabelText('Note for amsterdam shopper')).toBeNull());
    cleanup();
  });

  it('keeps a failed note draft open and allows a clean retry', async () => {
    const onSaveNote = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('Saved locally, but account sync failed.')
      .mockResolvedValueOnce(null);
    render(<ProfilePhoneCard {...props({ note: '', onSaveNote })} />);
    fireEvent.click(screen.getByLabelText('Edit note for amsterdam shopper'));
    fireEvent.change(screen.getByLabelText('Note for amsterdam shopper'), {
      target: { value: 'retry me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('account sync failed');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Note for amsterdam shopper')).toBeNull());
    expect(onSaveNote).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('shows identity + device + country + real exit IP + UDP badge; Launch fires onPrimary', () => {
    const onPrimary = vi.fn();
    render(<ProfilePhoneCard {...props({ onPrimary })} />);
    expect(screen.getByText('amsterdam shopper')).toBeTruthy();
    expect(screen.getByText('AS')).toBeTruthy();
    expect(screen.getByText('iPhone 17')).toBeTruthy();
    expect(screen.getByText('82.14.220.9')).toBeTruthy();
    expect(screen.getByText('NL')).toBeTruthy(); // country code badge
    expect(screen.getByText(/UDP/)).toBeTruthy(); // single UDP badge (hover → WebRTC/QUIC)
    expect(screen.getByText(/WebRTC/)).toBeTruthy(); // hover detail (in DOM)
    expect(screen.getByText('Idle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('running → Live status + an "Open session" primary action', () => {
    render(<ProfilePhoneCard {...props({ running: true })} />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open session' })).toBeTruthy();
    cleanup();
  });

  it('shows an inline, accessible launch spinner only for the launch action', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard {...props({ busy: true, launching: true })} />,
    );
    const starting = screen.getByRole('button', { name: 'Starting…' });
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-component="launch-spinner"]')).not.toBeNull();

    // `busy` also covers trim/delete/clone/reopen. Those actions must not make
    // the primary button falsely claim that a launch is underway.
    rerender(<ProfilePhoneCard {...props({ busy: true, launching: false })} />);
    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Launch' })).toHaveAttribute('aria-busy', 'false');
    expect(container.querySelector('[data-component="launch-spinner"]')).toBeNull();
    cleanup();
  });

  it('running + onStop → a Stop affordance in the ⋯ menu that fires onStop', () => {
    const onStop = vi.fn();
    render(<ProfilePhoneCard {...props({ running: true, onStop })} />);
    // The Stop row is the labelled "Stop <name>'s running session" menu row.
    fireEvent.click(screen.getByLabelText(/Stop .* running session/));
    expect(onStop).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('idle cards never show Stop, even when onStop is provided', () => {
    render(<ProfilePhoneCard {...props({ running: false, onStop: vi.fn() })} />);
    expect(screen.queryByLabelText(/Stop .* running session/)).toBeNull();
    cleanup();
  });

  it('running but no onStop → no Stop affordance', () => {
    render(<ProfilePhoneCard {...props({ running: true, onStop: undefined })} />);
    expect(screen.queryByLabelText(/Stop .* running session/)).toBeNull();
    cleanup();
  });

  it('Stop is disabled while busy (double-close guard)', () => {
    const onStop = vi.fn();
    render(<ProfilePhoneCard {...props({ running: true, busy: true, onStop })} />);
    const stop = screen.getByLabelText(/Stop .* running session/);
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
    cleanup();
  });

  it('Delete/Trim/Duplicate are disabled (with a hint) while ANOTHER profile is busy', () => {
    // The mutate handlers early-return on a global busyId; surface that as a
    // disabled button + tooltip so a click on an idle card isn't a silent no-op.
    render(
      <ProfilePhoneCard
        {...props({
          busy: false,
          anyBusy: true,
          onClone: vi.fn(),
          onTrim: vi.fn(),
          onDelete: vi.fn(),
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText('More actions'));
    const del = screen.getByLabelText(/^Delete /);
    // W3120 renamed the action: "Trim" was jargon, "Clear cache" is what a
    // customer looks for. The disabled-while-busy property is unchanged.
    //
    // The clear scopes moved behind a disclosure (four variants of a rare action
    // were burying the daily ones in a thirteen-item menu), so the row has to be
    // revealed before its disabled state can be read. The property under test is
    // untouched — only how deep the row sits.
    fireEvent.click(screen.getByLabelText(/^Clearing options for /));
    const trim = screen.getByLabelText(/^Clear cache for /);
    const dup = screen.getByLabelText(/^Duplicate /);
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect((trim as HTMLButtonElement).disabled).toBe(true);
    expect((dup as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute('title')).toMatch(/Another profile is busy/i);
    cleanup();
  });

  it('CRITICAL a profile that INHERITS the only saved proxy is marked as such, and one bound deliberately is not. Reported: adding a single proxy made every profile look linked to it. Nothing was written — with no explicit binding a profile resolves to the first saved proxy, and the egress widget then showed its country and exit IP exactly as though it had been chosen. Without this marker, adding a SECOND proxy silently moves every unbound profile.', () => {
    const { unmount } = render(<ProfilePhoneCard {...props({ proxyExplicit: false })} />);
    expect(
      screen.queryByTestId
        ? document.querySelector('[data-component="proxy-inherited-badge"]')
        : null,
      'an inherited proxy is presented as a deliberate binding',
    ).not.toBeNull();
    unmount();

    render(<ProfilePhoneCard {...props({ proxyExplicit: true })} />);
    expect(
      document.querySelector('[data-component="proxy-inherited-badge"]'),
      'a deliberately bound proxy was labelled as an inherited default',
    ).toBeNull();
  });

  it('never-probed → "run Test"; probed-no-IP → "no exit IP"; no proxy → "no proxy bound"', () => {
    render(<ProfilePhoneCard {...props({ exitIp: null, probed: false })} />);
    expect(screen.getByText('run Test')).toBeTruthy();
    cleanup();
    render(<ProfilePhoneCard {...props({ exitIp: null, probed: true })} />);
    expect(screen.getByText('no exit IP')).toBeTruthy();
    cleanup();
    render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    expect(screen.getByText('no proxy bound')).toBeTruthy();
    cleanup();
  });

  it('F1c: the Assist button fires onAssist when provided, absent otherwise', () => {
    const onAssist = vi.fn();
    render(<ProfilePhoneCard {...props({ onAssist })} />);
    fireEvent.click(screen.getByLabelText(/Ask the AI assistant about/));
    expect(onAssist).toHaveBeenCalledTimes(1);
    cleanup();
    render(<ProfilePhoneCard {...props({ onAssist: undefined })} />);
    expect(screen.queryByLabelText(/Ask the AI assistant about/)).toBeNull();
    cleanup();
  });

  it('the ⋯ menu opens on toggle and dismisses on an outside pointer-down (and Escape)', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const menu = container.querySelector('[data-component="card-actions-menu"]');
    const toggle = screen.getByRole('button', { name: 'More actions' });
    // classList membership (not substring) — the static class also carries a
    // `group-hover:opacity-100` token that a substring check would match.
    expect(menu?.classList.contains('opacity-0')).toBe(true);
    fireEvent.click(toggle);
    expect(menu?.classList.contains('opacity-100')).toBe(true);
    // A pointer-down anywhere outside the card footer closes it.
    fireEvent.pointerDown(document.body);
    expect(menu?.classList.contains('opacity-0')).toBe(true);
    // Re-open, then Escape closes it.
    fireEvent.click(toggle);
    expect(menu?.classList.contains('opacity-100')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu?.classList.contains('opacity-0')).toBe(true);
    cleanup();
  });

  it('Delete is enabled (and fires onDelete) when idle', () => {
    const onDelete = vi.fn();
    render(<ProfilePhoneCard {...props({ running: false, onDelete })} />);
    const del = screen.getByLabelText('Delete amsterdam shopper');
    expect((del as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('Delete is disabled with a "stop the session first" tooltip while running (server rejects deleting a running profile)', () => {
    const onDelete = vi.fn();
    render(<ProfilePhoneCard {...props({ running: true, onDelete })} />);
    const del = screen.getByLabelText('Delete amsterdam shopper');
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute('title')).toMatch(/stop the session first/i);
    fireEvent.click(del);
    expect(onDelete).not.toHaveBeenCalled();
    cleanup();
  });

  it('renders folder + tag pills', () => {
    render(<ProfilePhoneCard {...props({ folder: 'Shopping', tags: ['aged'] })} />);
    expect(screen.getByText('📁 Shopping')).toBeTruthy();
    expect(screen.getByText('aged')).toBeTruthy();
    cleanup();
  });

  it('tells an idle saved profile that its tabs reopen without inventing a count', () => {
    const { rerender } = render(
      <ProfilePhoneCard {...props({ savedTabsReopen: true, running: false })} />,
    );
    expect(screen.getByText('Saved tabs reopen')).toBeTruthy();
    expect(screen.getByText('Saved tabs reopen').getAttribute('title')).toMatch(/launch it/i);

    // Once live, the tabs are already open; the pre-launch promise should disappear.
    rerender(<ProfilePhoneCard {...props({ savedTabsReopen: true, running: true })} />);
    expect(screen.queryByText('Saved tabs reopen')).toBeNull();
    cleanup();
  });

  it('clicking the card toggles selection; Launch + Test do NOT select (stopPropagation)', () => {
    const onToggleSelect = vi.fn();
    const onTest = vi.fn();
    const onPrimary = vi.fn();
    render(<ProfilePhoneCard {...props({ onToggleSelect, onTest, onPrimary })} />);
    // whole-card click selects (no more tiny checkbox)
    fireEvent.click(screen.getByLabelText(/Select amsterdam shopper/));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    // action buttons act without bubbling to a select toggle
    fireEvent.click(screen.getByTitle(/Test proxy/));
    expect(onTest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1); // still 1 — buttons don't select
    cleanup();
  });
});

describe('the Clear group expands on CLICK, never on hover (V-2149)', () => {
  it('⛔ pointing at "Clear…" does not reveal the destructive rows', () => {
    // The group only exists when a trim handler does.
    render(<ProfilePhoneCard {...props({ onTrim: vi.fn() })} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    const group = screen.getByLabelText(/^Clearing options for /);

    // Hovering the group must not expand it: the rows below DESTROY state the
    // customer cannot get back, and expanding on hover slides one of them under
    // a cursor that was only passing through.
    fireEvent.mouseEnter(group);
    expect(screen.queryByLabelText(/^Clear history for /)).toBeNull();
    expect(group.getAttribute('aria-expanded')).toBe('false');

    // Nor does merely focusing it (keyboard traversal is not a choice to look).
    fireEvent.focus(group);
    expect(screen.queryByLabelText(/^Clear history for /)).toBeNull();

    // A click — the thing a disclosure button promises — opens it.
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(/^Clear history for /)).not.toBeNull();

    // And toggles shut again.
    fireEvent.click(group);
    expect(screen.queryByLabelText(/^Clear history for /)).toBeNull();
    cleanup();
  });

  it('(V-2166) ⛔ hovering a card does not unfurl its actions — only the ⋯ toggle opens them', () => {
    // The menu carried `group-hover:opacity-100 group-hover:pointer-events-auto`, so
    // dragging the pointer across the grid opened every card's actions in turn,
    // including Delete and the Clear group, over whatever card the cursor reached
    // (owner 2026-08-30). Same correction as V-2149's Clear group, one level up.
    const { container } = render(<ProfilePhoneCard {...props({ onTrim: vi.fn() })} />);
    const menu = container.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
    expect(
      menu,
      'the menu is always in the DOM (opacity-toggled) so labels stay queryable',
    ).not.toBeNull();

    // Closed: no hover class may make it interactive, and it must not be reachable.
    expect(menu.className).not.toMatch(/group-hover:opacity-100/);
    expect(menu.className).not.toMatch(/group-hover:pointer-events-auto/);
    expect(menu.className).toMatch(/pointer-events-none/);
    expect(menu.className).toMatch(/opacity-0/);

    // Hovering the CARD changes nothing.
    const card = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.mouseEnter(card);
    expect(menu.className).toMatch(/pointer-events-none/);

    // The ⋯ toggle is the only opener.
    fireEvent.click(screen.getByLabelText('More actions'));
    const opened = container.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
    expect(opened.className).toMatch(/pointer-events-auto/);
    expect(opened.className).toMatch(/opacity-100/);
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase A (2026-09-11) — "nothing outside the box". The owner's grid at its
// 178px minimum had 5–12 descendants of the card painting PAST the card in
// every state (measured over the real component: scratchpad measure-grid.mjs,
// now scripts/gui-visual-check.mjs). jsdom has no layout, so these arms freeze
// the CLASSES and DOM ORDER that the Playwright gate proved sufficient; the
// gate is the geometry proof, these are the tripwires that name the line.
//
// Every arm names its production line. Reverting that line removes the token
// (or the order) the arm reads, so the arm reds — that is the mutation each
// was reasoned against.
// ─────────────────────────────────────────────────────────────────────────────
const classes = (el: Element | null | undefined): string[] =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.length > 0);
const byComponent = (root: ParentNode, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-component="${name}"]`);

const CANNOT_ROUTE = {
  reachable: true,
  auth_ok: true,
  udp_associate: false,
  can_route: false,
  connect_reply: 0x05,
  latency_ms: 0,
  message: 'CONNECT refused',
} as const;

describe('Phase A — the phone card keeps every row inside its box', () => {
  it('R2/A2: the body clips X and keeps scrolling Y; screen, egress widget and both egress rows carry min-w-0', () => {
    // ProfilePhoneCard.tsx body div (`data-component="card-body"`): removing
    // `overflow-x-hidden` (the R2 root cause — `overflow-y-auto` alone forces
    // overflow-x:auto, and macOS overlay scrollbars hide the sideways scroll)
    // reds the first expectation; removing `min-w-0` from any of the four
    // containers reds the matching one.
    const { container } = render(<ProfilePhoneCard {...props({ proxyName: 'pool-04' })} />);
    const body = byComponent(container, 'card-body');
    expect(body, 'the scrolling body must be addressable').not.toBeNull();
    expect(classes(body)).toEqual(
      expect.arrayContaining(['overflow-x-hidden', 'overflow-y-auto', 'min-w-0', 'min-h-0']),
    );
    expect(classes(byComponent(container, 'phone-screen'))).toEqual(
      expect.arrayContaining(['overflow-hidden', 'min-w-0']),
    );
    expect(classes(byComponent(container, 'egress-widget'))).toEqual(
      expect.arrayContaining(['min-w-0', 'overflow-hidden', 'shrink-0']),
    );
    expect(classes(byComponent(container, 'exit-row'))).toContain('min-w-0');
    expect(classes(byComponent(container, 'profile-card-proxy-name'))).toContain('min-w-0');
    cleanup();
  });

  it('A1/A3: the latency row WRAPS; the number, vantage, checked stamp and UDP badge never break mid-line and never shrink', () => {
    // Latency row div (`data-component="latency-row"`): `flex-wrap` gone →
    // arm 1 reds; `gap-1.5` back in place of `gap-x-1.5 gap-y-1` → arm 2 reds.
    // The `.mono` span was 13px (bare .mono); `text-[10.5px]` gone → arm 3.
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-01' },
          checkedAtIso: '2026-06-15T06:30:00.000Z',
        })}
      />,
    );
    const row = byComponent(container, 'latency-row');
    expect(classes(row)).toEqual(
      expect.arrayContaining(['flex', 'flex-wrap', 'min-w-0', 'gap-x-1.5', 'gap-y-1']),
    );
    expect(classes(row)).not.toContain('gap-1.5');
    const number = container.querySelector('[data-latency-vantage]');
    expect(classes(number)).toEqual(
      expect.arrayContaining(['mono', 'text-[10.5px]', 'whitespace-nowrap']),
    );
    const vantage = screen.getByText('from the test Mac');
    expect(classes(vantage)).toContain('whitespace-nowrap');
    const checked = byComponent(container, 'proxy-checked-at');
    expect(classes(checked)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    const udp = container.querySelector('[data-udp]');
    expect(classes(udp)).toEqual(
      expect.arrayContaining(['shrink-0', 'whitespace-nowrap', 'ml-auto']),
    );
    cleanup();

    // The null-latency arm renders a sibling `.mono` ("stale"/"untested") that
    // had the same bare 13px problem (L611 on main).
    render(<ProfilePhoneCard {...props({ latencyMs: null, probed: true })} />);
    expect(classes(screen.getByText('stale'))).toEqual(
      expect.arrayContaining(['mono', 'text-[10.5px]', 'whitespace-nowrap']),
    );
    cleanup();
  });

  it('A4: the broken-proxy banner renders FIRST in the egress widget, its label flexes, and Retest+Change travel as one non-shrinking unit', () => {
    // Banner block moved above the exit row: swapping it back reds the
    // compareDocumentPosition arm. Label span without `flex-1` reds arm 2; the
    // wrapper `<span className="ml-auto flex shrink-0 gap-1.5 whitespace-nowrap">`
    // removed (buttons back as direct children, Retest with `ml-auto`) reds 3–4.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: CANNOT_ROUTE, onEdit: vi.fn() })}
      />,
    );
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    const exitRow = byComponent(container, 'exit-row') as HTMLElement;
    const widget = byComponent(container, 'egress-widget') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(widget.contains(banner)).toBe(true);
    expect(
      banner.compareDocumentPosition(exitRow) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the verdict must come before the exit row — the body scrolls, so the last rows are the ones that vanish',
    ).toBeTruthy();
    expect(widget.firstElementChild).toBe(banner);

    const label = screen.getByText('Cannot route');
    expect(classes(label)).toEqual(expect.arrayContaining(['min-w-0', 'flex-auto', 'truncate']));
    expect(classes(label)).not.toContain('flex-1');
    expect(label.getAttribute('title')).toBe('CONNECT refused');

    const retest = screen.getByRole('button', { name: 'Retest' });
    const change = screen.getByRole('button', { name: 'Change' });
    expect(retest.parentElement).toBe(change.parentElement);
    expect(classes(retest.parentElement)).toEqual(
      expect.arrayContaining(['ml-auto', 'flex', 'shrink-0', 'whitespace-nowrap']),
    );
    expect(classes(retest)).not.toContain('ml-auto');
    cleanup();
  });

  it('A5: the ⋯ menu is anchored to BOTH card edges (no fixed 176px), capped in height and scrolls', () => {
    // Menu div (`data-component="card-actions-menu"`): `w-44` back → arm 1
    // reds (176px on a 178px card started 10px left of the card in all 8 states);
    // `left-1.5` dropped → arm 2; `max-h-[260px]`/`overflow-y-auto` dropped → 3.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const menu = classes(byComponent(container, 'card-actions-menu'));
    expect(menu).not.toContain('w-44');
    expect(menu.some((c) => /^w-(\d|\[)/.test(c) && c !== 'w-auto')).toBe(false);
    expect(menu).toEqual(expect.arrayContaining(['left-1.5', 'right-1.5', 'absolute']));
    expect(menu).toEqual(expect.arrayContaining(['max-h-[260px]', 'overflow-y-auto']));
    cleanup();
  });

  it('A6: a 60-char name is clamped inside the card and carries the full name as its title', () => {
    // Name `<p>`: `title={p.name}` removed → arm 1 reds; `max-w-full` removed →
    // arm 2 (a flex-column child sized by its content could still exceed 144px).
    const name = 'amsterdam shopper for the netherlands christmas campaigns 26';
    expect(name).toHaveLength(60);
    render(<ProfilePhoneCard {...props({ name })} />);
    const p = screen.getByText(name);
    expect(p.getAttribute('title')).toBe(name);
    expect(classes(p)).toEqual(expect.arrayContaining(['line-clamp-1', 'max-w-full']));
    cleanup();
  });

  it('A7: the note clamp lives on an inner span, never on the <button>', () => {
    // Note button: a line-clamped <button> is display:-webkit-box, which drops
    // its own box sizing and let the note paint past the card. Moving the class
    // back onto the button reds both arms.
    const { container } = render(
      <ProfilePhoneCard {...props({ note: 'x '.repeat(40).trim(), onSaveNote: vi.fn() })} />,
    );
    const button = screen.getByTitle('Click to edit note');
    expect(classes(button)).not.toContain('line-clamp-2');
    const inner = byComponent(container, 'profile-note') as HTMLElement;
    expect(button.contains(inner)).toBe(true);
    expect(classes(inner)).toContain('line-clamp-2');
    cleanup();
  });

  it('A8: the VPN failure sentence and the VPN notice are clamped to two lines, titled with the full text', () => {
    // vpnFailure div / vpnNotice div: `line-clamp-2` removed from either reds it.
    const failure = 'The test Mac could not bring the tunnel up: handshake timed out after 20 s.';
    const notice = 'Tunnel test not run this time — a live session holds the tunnel.';
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          exitIp: null,
          latencyMs: null,
          capabilities: null,
          vpnFailure: failure,
          vpnNotice: notice,
        })}
      />,
    );
    const f = byComponent(container, 'proxy-vpn-failure');
    const n = byComponent(container, 'proxy-vpn-notice');
    expect(classes(f)).toContain('line-clamp-2');
    expect(f?.getAttribute('title')).toBe(failure);
    expect(classes(n)).toContain('line-clamp-2');
    expect(n?.getAttribute('title')).toBe(notice);
    cleanup();
  });

  it('A9: the folder/tag row is height-capped and clipped; every pill truncates within the row and is titled', () => {
    // Tags row (`data-component="tags-row"`): `max-h-[43px]`/`overflow-hidden`
    // removed → arm 1 (47px below the card in the busiest state). Pill without
    // `max-w-full truncate` / title → arms 2–3.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ folder: 'Shopping / Netherlands', tags: ['retail', 'a-very-long-tag-name-x'] })}
      />,
    );
    const row = byComponent(container, 'tags-row') as HTMLElement;
    expect(classes(row)).toEqual(
      expect.arrayContaining(['max-h-[43px]', 'overflow-hidden', 'shrink-0']),
    );
    const pills = Array.from(row.children);
    expect(pills).toHaveLength(3);
    for (const pill of pills) {
      expect(classes(pill)).toEqual(expect.arrayContaining(['max-w-full', 'truncate']));
      expect(pill.getAttribute('title')).toBeTruthy();
    }
    expect(screen.getByText('📁 Shopping / Netherlands').getAttribute('title')).toBe(
      'Shopping / Netherlands',
    );
    expect(screen.getByText('a-very-long-tag-name-x').getAttribute('title')).toBe(
      'a-very-long-tag-name-x',
    );
    cleanup();
  });

  it('A10: the exit slot keeps a 3ch floor and the "default" badge never shrinks', () => {
    // Exit span: `min-w-[3ch]` → `min-w-0` reds arm 1 (a 15-char IPv4 beside
    // flag + code + badge collapsed the slot to nothing). Badge without
    // `shrink-0` reds arm 2.
    const { container } = render(
      <ProfilePhoneCard {...props({ proxyExplicit: false, exitIp: '255.255.255.255' })} />,
    );
    expect(classes(screen.getByText('255.255.255.255'))).toContain('min-w-[3ch]');
    expect(classes(byComponent(container, 'proxy-inherited-badge'))).toContain('shrink-0');
    cleanup();
  });

  it('A11: the hover WebRTC/QUIC row wraps instead of pushing its second chip past the widget', () => {
    // Hover row div: `flex-wrap` removed reds it (it stays `hidden group-hover:flex`).
    render(<ProfilePhoneCard {...props()} />);
    const row = screen.getByText(/^WebRTC/).parentElement;
    expect(classes(row)).toEqual(
      expect.arrayContaining(['flex-wrap', 'hidden', 'group-hover:flex']),
    );
    cleanup();
  });

  it('CONTROL — in EVERY gallery state the Launch control is present, unhidden and OUTSIDE the scrolling body; every truncate/line-clamp element has a title on itself or an ancestor', () => {
    // Renders the harness's own STATES (imported, not copied) so a state added
    // for the screenshot is a state this arm covers. The dock is a sibling of
    // the body, so a scroll can never hide Launch — moving the footer inside
    // `card-body` reds the containment arm for all states at once.
    expect(STATES.length).toBeGreaterThanOrEqual(20);
    for (const state of STATES) {
      const { container, unmount } = render(<ProfilePhoneCard {...state.props} />);
      const article = container.querySelector('article') as HTMLElement;
      const body = byComponent(container, 'card-body') as HTMLElement;
      expect(body, `${state.label}: card-body missing`).not.toBeNull();
      const launch = screen.getByRole('button', { name: /^(Launch|Open session|Starting…)$/ });
      expect(launch.hidden, `${state.label}: Launch hidden`).toBe(false);
      expect(classes(launch), `${state.label}: Launch hidden by class`).not.toContain('hidden');
      expect(
        launch.closest('[aria-hidden="true"]'),
        `${state.label}: Launch aria-hidden`,
      ).toBeNull();
      expect(article.contains(launch), `${state.label}: Launch outside the card`).toBe(true);
      expect(body.contains(launch), `${state.label}: Launch inside the scrolling body`).toBe(false);

      const clamped = article.querySelectorAll('.truncate, [class*="line-clamp-"]');
      expect(
        clamped.length,
        `${state.label}: no clamped text at all — selector broke`,
      ).toBeGreaterThan(0);
      for (const el of clamped) {
        expect(
          el.closest('[title]'),
          `${state.label}: clamped text without a title — ${el.tagName} "${(el.textContent ?? '').trim().slice(0, 40)}"`,
        ).not.toBeNull();
      }
      unmount();
    }
  });
});
