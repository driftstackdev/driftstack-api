// GX ProfilePhoneCard — the phone-framed grid card. Asserts the core data shows
// (name, device, exit place / untested pill), status (Live/Idle), folder/tag
// pills, and that the dock actions + selection fire their handlers.
//
// Phase B (2026-09-11) — the "simulator tile": a fixed 234px card of eight
// single-line fixed-height regions. jsdom has no layout, so the arms below pin
// the RULES (the health-pill precedence, the JS chip/meta caps, the region
// classes and order, the copy) and scripts/gui-visual-check.mjs proves the
// geometry at 178/240/260px. Every arm names its production line; reverting
// that line is the mutation each was reasoned against.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProfilePhoneCard,
  healthPill,
  capsMode,
  visibleChips,
  visibleMeta,
  terseAgo,
  thumbUsesDarkInk,
  vpnFailureClause,
  vpnNoticeClause,
  DEFAULT_CONTENT_WIDTH,
  PROBE_ORIGIN_TITLE,
  SERVER_LATENCY_TITLE,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import { STATES } from '../../src/visual-harness/gallery';
import { RelativeTime, formatRelativeNarrow } from '../../src/components/RelativeTime';
import {
  CHECK_VPN_ACTION,
  CHECK_VPN_TITLE,
  ENDPOINT_OK_PILL,
  ENDPOINT_OK_TITLE,
  ENDPOINT_UNRESOLVED,
  ENDPOINT_UNRESOLVED_EXIT_TITLE,
  EXIT_GEO_UNAVAILABLE,
  EXIT_GEO_UNAVAILABLE_SHORT,
  EXIT_GEO_UNAVAILABLE_TITLE,
  RECHECK_ACTION,
  RETEST_ACTION,
  VPN_LATENCY_NOT_MEASURED,
  VPN_NO_API_KEY_CHECK_NOTICE,
  VPN_NO_EXIT_YET,
  VPN_NO_EXIT_YET_SHORT,
  VPN_NO_EXIT_YET_TITLE,
  VPN_NO_LATENCY_YET_TITLE,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_TUNNEL_UP_NO_LATENCY_TITLE,
} from '../../src/lib/proxy-check-copy';

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

const classes = (el: Element | null | undefined): string[] =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.length > 0);
const byComponent = (root: ParentNode, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-component="${name}"]`);
const byRegion = (root: ParentNode, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-region="${name}"]`);
const pill = (root: ParentNode): HTMLElement => {
  const all = root.querySelectorAll('[data-component="health-pill"]');
  expect(all.length, 'exactly one health pill').toBe(1);
  return all[0] as HTMLElement;
};

const CANNOT_ROUTE = {
  reachable: true,
  auth_ok: true,
  udp_associate: false,
  can_route: false,
  connect_reply: 0x05,
  latency_ms: 0,
  message: 'CONNECT refused',
} as const;
const NOT_REACHABLE = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'The proxy did not answer.',
} as const;
const REAL_OS = { os: 'macos-or-ios', confidence: 'high', reason: 'TTL 64, MSS 1460' } as const;

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

  it('shows identity + device + flag + exit place (IP in the title) + UDP chip; Launch fires onPrimary', () => {
    // Phase B (B10 :109) — the CC chip is gone and the exit IP rides in the exit
    // line's title; the line reads the place, here the country code because no
    // location label was passed.
    const onPrimary = vi.fn();
    const { container } = render(<ProfilePhoneCard {...props({ onPrimary })} />);
    expect(screen.getByText('amsterdam shopper')).toBeTruthy();
    expect(screen.getByText('AS')).toBeTruthy();
    expect(screen.getByText('iPhone 17')).toBeTruthy();
    const exit = byRegion(container, 'exit') as HTMLElement;
    expect(exit.textContent).toContain('🇳🇱');
    expect(screen.getByText('NL').getAttribute('title')).toBe('NL · 82.14.220.9');
    expect(screen.queryByText('82.14.220.9')).toBeNull();
    const udp = container.querySelector('[data-udp="true"]') as HTMLElement;
    expect(udp.textContent).toBe('UDP ✓');
    expect(udp.getAttribute('title')).toMatch(/WebRTC ✓/); // the hover detail moved into the title
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
    // B9 — the launching word is the LIST's ('Launching…', ProfilesTable), not
    // 'Starting…': one action, one name on both views.
    const { container, rerender } = render(
      <ProfilePhoneCard {...props({ busy: true, launching: true })} />,
    );
    const starting = screen.getByRole('button', { name: 'Launching…' });
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-component="launch-spinner"]')).not.toBeNull();
    expect(screen.queryByText(/Starting…/)).toBeNull();

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
    const { unmount, container } = render(
      <ProfilePhoneCard {...props({ proxyExplicit: false })} />,
    );
    const badge = document.querySelector('[data-component="proxy-inherited-badge"]');
    expect(badge, 'an inherited proxy is presented as a deliberate binding').not.toBeNull();
    // B10 (:211/:219) — Phase B moved the badge from the exit row to the via row (N5).
    expect(byRegion(container, 'via')?.contains(badge)).toBe(true);
    unmount();

    render(<ProfilePhoneCard {...props({ proxyExplicit: true })} />);
    expect(
      document.querySelector('[data-component="proxy-inherited-badge"]'),
      'a deliberately bound proxy was labelled as an inherited default',
    ).toBeNull();
  });

  it('never-probed → "untested" pill + "untested" exit line (the LIST\'s cell word) titled with what a Test does; probed-no-IP → "no exit IP" titled with what fills it (a failed SOCKS5: its message); no proxy → "no proxy bound"', () => {
    // B10 (:226) — 'run Test' is gone from the exit line: the check word lives
    // in the pill (arm 5) and the Test button in the caps row (mode C).
    // Polish — the null-exit arm is SPLIT: never probed reads 'untested'
    // (ProfilesTable's `r.probed ? 'no exit IP' : 'untested'`), and no title
    // restates its text. Reverting the split (one 'no exit IP' arm titled
    // 'no exit IP') reds all three title arms.
    const { container: a } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, countryCode: null, probed: false, capabilities: null })}
      />,
    );
    expect(pill(a).textContent).toBe('untested');
    const exitA = byRegion(a, 'exit') as HTMLElement;
    expect(exitA.textContent).toBe('untested');
    expect(within(exitA).getByText('untested').getAttribute('title')).toBe(
      'Test proxy from this Mac — reachability, latency, exit IP',
    );
    expect(screen.queryByText('no exit IP')).toBeNull();
    expect(screen.queryByText('run Test')).toBeNull();
    expect(source('components/ProfilesTable.tsx')).toContain(
      "r.probed ? 'no exit IP' : 'untested'",
    );
    cleanup();
    render(<ProfilePhoneCard {...props({ exitIp: null, countryCode: null, probed: true })} />);
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe(
      'No exit was measured by the last test — run Test proxy again',
    );
    cleanup();
    render(
      <ProfilePhoneCard
        {...props({
          exitIp: null,
          countryCode: null,
          latencyMs: null,
          capabilities: NOT_REACHABLE,
        })}
      />,
    );
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe('The proxy did not answer.');
    cleanup();
    const { container: none } = render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    expect(screen.getByText('no proxy bound').getAttribute('title')).toBe('Choose a proxy in Edit');
    // The 🚫 emoji is gone: one dashed placeholder ring for every glyph-less exit.
    expect(none.textContent).not.toContain('🚫');
    expect(byComponent(byRegion(none, 'exit') as HTMLElement, 'exit-placeholder')).not.toBeNull();
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
    render(<ProfilePhoneCard {...props()} />);
    // Phase C: the menu is PORTALED to document.body — queried on the document.
    const menu = document.querySelector('[data-component="card-actions-menu"]');
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
    // Phase B: the menu is a sibling of the screen (so it can open downward
    // past the screen's overflow-hidden); a pointer-down INSIDE it must not
    // count as outside, or every row click would close it before it fired.
    // Phase C: the menu is a PORTAL node (no descendant of the card at all) —
    // `menuRef.contains` is what makes it "inside"; a DOM-ancestry test would
    // close it on every row click.
    fireEvent.click(toggle);
    fireEvent.pointerDown(menu as Element);
    expect(menu?.classList.contains('opacity-100')).toBe(true);
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

  it('tells an idle saved profile that its tabs reopen without inventing a count — as a ↻ on Launch whose title carries the sentence (N11)', () => {
    // B10 (:299-304) — the "Saved tabs reopen" pill became the ↻ glyph inside
    // the Launch button; the sentence is the button's title.
    const { rerender } = render(
      <ProfilePhoneCard {...props({ savedTabsReopen: true, running: false })} />,
    );
    const launch = screen.getByRole('button', { name: 'Launch' });
    const glyph = document.querySelector('[data-component="saved-tabs-reopen"]');
    expect(glyph).not.toBeNull();
    expect(launch.contains(glyph)).toBe(true);
    expect(launch.getAttribute('title')).toMatch(/launch it/i);
    expect(screen.queryByText('Saved tabs reopen')).toBeNull();

    // Once live, the tabs are already open; the pre-launch promise should disappear.
    rerender(<ProfilePhoneCard {...props({ savedTabsReopen: true, running: true })} />);
    expect(document.querySelector('[data-component="saved-tabs-reopen"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open session' }).getAttribute('title')).not.toMatch(
      /launch it/i,
    );
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
    const menu = document.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
    expect(
      menu,
      'the menu is always in the DOM (opacity-toggled, portaled to body) so labels stay queryable',
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
    const opened = document.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
    expect(opened.className).toMatch(/pointer-events-auto/);
    expect(opened.className).toMatch(/opacity-100/);
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase B (2026-09-11) — the simulator tile. The rules below are what the
// Playwright gate proved sufficient for 0 escapes / 0 scroll / 234px at every
// width; jsdom pins them so the geometry cannot silently regress between runs
// of the gate.
// ─────────────────────────────────────────────────────────────────────────────
const SRC = resolve(__dirname, '../../src');
const source = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

const VPN_DOWN = 'The test Mac could not bring the tunnel up: handshake timed out after 20 s.';
const VPN_NOTICE = 'Tunnel test not run this time — a live session holds the tunnel.';

describe('B1 — the health pill: ONE element, seven arms, strict precedence (healthPill)', () => {
  // ProfilePhoneCard.tsx `healthPill`: each arm below is one `if` in order.
  // Swapping arms 2 and 7 (or deleting arm 2) makes a failed SOCKS5 read
  // 'not measured' → the CRITICAL arm reds; deleting the running+broken
  // independence (the session pill is a separate element) reds arm 2b.
  it('arm 1 — no proxy → "no proxy" · none · muted', () => {
    const { container } = render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    const el = pill(container);
    expect(el.textContent).toBe('no proxy');
    expect(el.getAttribute('data-health')).toBe('none');
    // Polish — muted is the comp's translucent slate + ink2, never the
    // near-black inset (the quietest states were the darkest object on the tile).
    expect(classes(el)).toEqual(expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']));
    expect(classes(el)).not.toContain('bg-surface-inset');
    expect(classes(el)).not.toContain('text-ink-muted');
    expect(healthPill(props({ hasProxy: false }))).toMatchObject({
      text: 'no proxy',
      state: 'none',
      tone: 'muted',
    });
    cleanup();
  });

  it('CRITICAL arm 2 — a failed SOCKS5 → the shared verdict label (error tint, message as title); "stale" and "not measured" appear NOWHERE; running + broken shows both "Live" and the label', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: NOT_REACHABLE })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe('Not reachable');
    expect(el.getAttribute('data-health')).toBe('broken');
    // Polish — the error ink is red-300 on the red tint (the red-400 token
    // measured 3.3–3.8:1 there at 10px); the tint is unchanged.
    expect(classes(el)).toEqual(expect.arrayContaining(['bg-status-error/15', 'text-[#fca5a5]']));
    expect(classes(el)).not.toContain('text-status-error');
    expect(el.getAttribute('title')).toBe('The proxy did not answer.');
    expect(container.textContent).not.toMatch(/stale/);
    expect(container.textContent).not.toMatch(/not measured/);
    // The other two verdict words come from the same function.
    expect(healthPill(props({ capabilities: { ...NOT_REACHABLE, reachable: true } })).text).toBe(
      'Auth failed',
    );
    expect(healthPill(props({ capabilities: CANNOT_ROUTE })).text).toBe('Cannot route');
    // Arm 2 outranks a test in flight (4), a number (6) and 'not measured' (7).
    expect(healthPill(props({ capabilities: NOT_REACHABLE, testing: true })).text).toBe(
      'Not reachable',
    );
    expect(healthPill(props({ capabilities: NOT_REACHABLE, latencyMs: 12 })).text).toBe(
      'Not reachable',
    );
    cleanup();

    const { container: live } = render(
      <ProfilePhoneCard {...props({ running: true, capabilities: NOT_REACHABLE })} />,
    );
    expect(screen.getByText('Live')).toBeTruthy();
    expect(pill(live).textContent).toBe('Not reachable');
    cleanup();
  });

  it('arm 3 — a VPN whose tunnel test failed → "VPN tunnel down" · broken · error; title = failure (+ " — " + notice when both, G6)', () => {
    const base = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      vpnFailure: VPN_DOWN,
    };
    const { container } = render(<ProfilePhoneCard {...props(base)} />);
    const el = pill(container);
    expect(el.textContent).toBe('VPN tunnel down');
    expect(el.getAttribute('data-health')).toBe('broken');
    expect(el.getAttribute('title')).toBe(VPN_DOWN);
    cleanup();
    expect(healthPill(props({ ...base, vpnNotice: VPN_NOTICE })).title).toBe(
      `${VPN_DOWN} — ${VPN_NOTICE}`,
    );
    // Outranks a test in flight and a standing fleet number.
    expect(healthPill(props({ ...base, testing: true })).text).toBe('VPN tunnel down');
    expect(healthPill(props({ ...base, latencyMs: 61 })).text).toBe('VPN tunnel down');
    // Gated on `vpn` (l #16): a socks5 row keeps no tunnel banner from a stale cache entry.
    expect(healthPill(props({ ...base, vpn: false })).text).not.toBe('VPN tunnel down');
  });

  it('arm 4 — a test in flight → "Testing…" | "Checking…" (VPN) · checking · muted, with a pulsing dot; outranks the number and "untested"', () => {
    const { container } = render(<ProfilePhoneCard {...props({ testing: true })} />);
    const el = pill(container);
    expect(el.textContent).toBe('Testing…');
    expect(el.getAttribute('data-health')).toBe('checking');
    expect(el.querySelector('.animate-pulse')).not.toBeNull();
    cleanup();
    expect(healthPill(props({ testing: true, vpn: true })).text).toBe('Checking…');
    expect(healthPill(props({ testing: true, probed: false, capabilities: null })).text).toBe(
      'Testing…',
    );
    // Polish — a LAUNCH runs the proxy check, so the pill says so instead of
    // keeping the stale number; its title names the launch, not the Test.
    const launching = healthPill(props({ launching: true, busy: true }));
    expect(launching).toMatchObject({ text: 'Testing…', state: 'checking', tone: 'muted' });
    expect(launching.title).toBe('Checking the proxy before the session starts');
    expect(healthPill(props({ launching: true, busy: true, vpn: true })).text).toBe('Checking…');
    const { container: launch } = render(
      <ProfilePhoneCard {...props({ launching: true, busy: true })} />,
    );
    expect(pill(launch).getAttribute('data-health')).toBe('checking');
    expect(launch.textContent).not.toContain('42ms');
    cleanup();
  });

  it('arm 5 — never probed, nothing measured → "untested" · untested · muted, titled with what a Test does', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ probed: false, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe('untested');
    expect(el.getAttribute('data-health')).toBe('untested');
    expect(el.getAttribute('title')).toBe(
      'Test proxy from this Mac — reachability, latency, exit IP',
    );
    cleanup();
    expect(
      healthPill(props({ probed: false, capabilities: null, latencyMs: null, vpn: true })).title,
    ).toBe(CHECK_VPN_TITLE);
  });

  it('arm 6 — a number → `${n}ms`, ready when latencyGood else busy; the title says WHERE it was measured and NOTHING else (polish: it appended the SOCKS5 label\'s own "· 42 ms" — a second number beside the pill\'s)', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const el = pill(container);
    expect(el.textContent).toBe('42ms');
    expect(el.getAttribute('data-health')).toBe('ok');
    expect(classes(el)).toEqual(
      expect.arrayContaining(['bg-status-ready/10', 'text-status-ready']),
    );
    expect(el.getAttribute('title')).toBe(PROBE_ORIGIN_TITLE);
    expect(el.getAttribute('title')).not.toMatch(/Reachable|\d+ ms/);
    expect(el.getAttribute('data-latency-vantage')).toBe('this_mac');
    cleanup();
    // A fleet number of 88 beside a native 42: the title must not carry the 42.
    expect(
      healthPill(
        props({
          latencyMs: 88,
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
        }),
      ).title,
    ).not.toMatch(/42/);

    const slow = healthPill(props({ latencyMs: 210, latencyGood: false }));
    expect(slow).toMatchObject({ text: '210ms', state: 'slow', tone: 'busy' });
    // T-1 — a server number names the machine that measured it (D2 — the words
    // that were a visible label + a 26px bar now live here).
    const fleet = healthPill(
      props({
        latencyFromServer: true,
        latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
      }),
    );
    expect(fleet.title).toContain('Measured from the Mac that runs your profiles (mac-mini-07)');
    const cp = healthPill(
      props({ latencyFromServer: true, latencyVantage: { measuredFrom: 'control_plane' } }),
    );
    expect(cp.title).toContain('No test Mac was free');
    // VACUITY CONTROL — a server number with no vantage keeps the plain server sentence.
    expect(healthPill(props({ latencyFromServer: true })).title).toBe(SERVER_LATENCY_TITLE);
    // A VPN fleet number has no SOCKS5 verdict to append.
    expect(
      healthPill(props({ vpn: true, capabilities: null, latencyMs: 61, latencyFromServer: true }))
        .title,
    ).toBe(SERVER_LATENCY_TITLE);
  });

  it('arm 7 — probed, no number, no failure → "not measured" · unmeasured · muted (VPN title = notice ?? the no-exit sentence); "stale" is deleted (G9)', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe(VPN_LATENCY_NOT_MEASURED);
    expect(el.getAttribute('data-health')).toBe('unmeasured');
    expect(el.getAttribute('title')).toBe(VPN_NO_EXIT_YET_TITLE);
    cleanup();
    expect(
      healthPill(props({ vpn: true, capabilities: null, latencyMs: null, vpnNotice: VPN_NOTICE }))
        .title,
    ).toBe(VPN_NOTICE);
    // A probed SOCKS5 row with no number is the same arm — never 'stale'.
    const { container: socks } = render(
      <ProfilePhoneCard
        {...props({ capabilities: null, latencyMs: null, exitIp: null, probed: true })}
      />,
    );
    expect(pill(socks).textContent).toBe('not measured');
    expect(socks.textContent).not.toMatch(/stale/);
    cleanup();
  });

  it('(o) arm 7 beside an EXIT — a VPN whose exit row shows a place (session-reported, no fleet number) is titled VPN_NO_LATENCY_YET_TITLE, never "No exit measured yet"', () => {
    // healthPill's final return: `vpnUnmeasuredTitle` picks VPN_NO_LATENCY_YET_TITLE
    // when exitIp is set. Reverting it to the bare VPN_NO_EXIT_YET_TITLE puts
    // "No exit measured yet" two rows above '🇨🇭 Zürich, Zurich' → reds here.
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          latencyFromServer: false,
          exitIp: '185.22.1.9',
          countryCode: 'CH',
          flag: '🇨🇭',
          locationLabel: 'Zürich, Zurich',
        })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe(VPN_LATENCY_NOT_MEASURED);
    expect(el.getAttribute('title')).toBe(VPN_NO_LATENCY_YET_TITLE);
    expect(el.getAttribute('title')).not.toMatch(/No exit measured yet/);
    // The exit row shows the exit the title must not deny.
    expect((byRegion(container, 'exit') as HTMLElement).textContent).toContain('Zürich, Zurich');
    // A notice still outranks the derived title; with no exit the sentence is unchanged.
    expect(
      healthPill(
        props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: '1.2.3.4',
          vpnNotice: VPN_NOTICE,
        }),
      ).title,
    ).toBe(VPN_NOTICE);
    expect(
      healthPill(props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })).title,
    ).toBe(VPN_NO_EXIT_YET_TITLE);
    // Still mode C: nothing fleet-measured, so Check VPN is the honest next step.
    expect(
      capsMode(props({ vpn: true, capabilities: null, latencyMs: null, exitIp: '1.2.3.4' })),
    ).toBe('first');
    cleanup();
  });

  it('(o) arm 6b — a VPN the test Mac brought UP with no number → "tunnel up" · ok · ready, the grid’s shared title, data-latency-vantage="fleet"; the caps row is mode A (what that reply measured)', () => {
    // `tunnelUpNoLatency` (vpn && latencyMs === null && vantage fleet) feeds a
    // pill arm above arm 7 AND capsMode's measured arm. Deleting the pill arm
    // reds the text; deleting the capsMode clause reds the mode (it falls to
    // 'first' and offers Check VPN under a green pill).
    const up = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      latencyFromServer: false,
      latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-02' } as const,
      quicProbe: true,
      exitIp: '185.22.1.10',
      countryCode: 'AT',
      flag: '🇦🇹',
      locationLabel: 'Vienna, Vienna',
    };
    const { container } = render(<ProfilePhoneCard {...props(up)} />);
    const el = pill(container);
    expect(el.textContent).toBe('tunnel up');
    expect(el.getAttribute('data-health')).toBe('ok');
    expect(classes(el)).toContain('text-status-ready');
    expect(el.getAttribute('title')).toBe(VPN_TUNNEL_UP_NO_LATENCY_TITLE);
    expect(el.getAttribute('data-latency-vantage')).toBe('fleet');
    expect(container.textContent).not.toMatch(/not measured/);
    expect(screen.queryByRole('button', { name: CHECK_VPN_ACTION })).toBeNull();
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('measured');
    expect(caps.querySelector('[data-quic-inferred="false"]')?.textContent).toBe('QUIC ✓');
    cleanup();
    expect(healthPill(props({ ...up, vpnNotice: VPN_NOTICE })).title).toBe(
      `${VPN_TUNNEL_UP_NO_LATENCY_TITLE} — ${VPN_NOTICE}`,
    );
    // Precedence: a number (6), a test in flight (4) and a failure (3) all outrank it.
    expect(healthPill(props({ ...up, latencyMs: 61, latencyFromServer: true })).text).toBe('61ms');
    expect(healthPill(props({ ...up, testing: true })).text).toBe('Checking…');
    expect(healthPill(props({ ...up, vpnFailure: VPN_DOWN })).text).toBe('VPN tunnel down');
    // VACUITY CONTROLS — the vantage alone is not "up": a control-plane vantage
    // or a SOCKS5 row with a fleet vantage and no number stays arm 7.
    expect(
      healthPill(props({ ...up, latencyVantage: { measuredFrom: 'control_plane' } })).text,
    ).toBe('not measured');
    expect(healthPill(props({ ...up, vpn: false, probed: true })).text).toBe('not measured');
    expect(capsMode(props({ ...up, latencyVantage: { measuredFrom: 'control_plane' } }))).toBe(
      'first',
    );
    // The grid renders the same sentence for the same cache entry — it now
    // imports the constant from lib/proxy-check-copy (the grid follow-up landed),
    // so the pin is that ProxiesView USES that constant, never a retyped literal.
    expect(source('views/ProxiesView.tsx')).toMatch(/\bVPN_TUNNEL_UP_NO_LATENCY_TITLE\b/);
    expect(source('views/ProxiesView.tsx')).toContain('tunnel up · no latency');
  });

  it('(polish) arm 6c — a VPN whose endpoint RESOLVED and whose tunnel was never brought up → "endpoint ok" · unmeasured · muted, the Proxies grid\'s word + title (+ the notice); never on a SOCKS5 row, an unresolved one, or over the arms above it', () => {
    // healthPill arm 6c (`p.vpn === true && p.endpoint?.resolved === true`):
    // deleting it drops the row to arm 7 → 'not measured', a word the grid never
    // shows for this cache entry (ProxiesView's EndpointHealthPill: 'endpoint ok').
    const ok = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      flag: '🌍',
      endpoint: { resolved: true, message: 'Resolved' },
    };
    const { container } = render(<ProfilePhoneCard {...props(ok)} />);
    const el = pill(container);
    expect(el.textContent).toBe(ENDPOINT_OK_PILL);
    expect(el.textContent).toBe('endpoint ok');
    expect(ENDPOINT_OK_PILL.length).toBeLessThanOrEqual(15);
    expect(el.getAttribute('data-health')).toBe('unmeasured');
    expect(classes(el)).toContain('text-ink-secondary');
    expect(el.getAttribute('title')).toBe(ENDPOINT_OK_TITLE);
    expect(container.textContent).not.toMatch(/not measured/);
    // Still mode C: the tunnel was never brought up, Check VPN is the next step.
    expect((byRegion(container, 'caps') as HTMLElement).getAttribute('data-caps-mode')).toBe(
      'first',
    );
    expect(screen.getByRole('button', { name: CHECK_VPN_ACTION })).toBeTruthy();
    cleanup();
    expect(healthPill(props({ ...ok, vpnNotice: VPN_NOTICE })).title).toBe(
      `${ENDPOINT_OK_TITLE} — ${VPN_NOTICE}`,
    );
    // Precedence: 6b, 6, 4, 3 and 3b all outrank it.
    expect(healthPill(props({ ...ok, latencyVantage: { measuredFrom: 'fleet' } })).text).toBe(
      'tunnel up',
    );
    expect(healthPill(props({ ...ok, latencyMs: 61, latencyFromServer: true })).text).toBe('61ms');
    expect(healthPill(props({ ...ok, testing: true })).text).toBe('Checking…');
    expect(healthPill(props({ ...ok, vpnFailure: VPN_DOWN })).text).toBe('VPN tunnel down');
    expect(
      healthPill(props({ ...ok, endpoint: { resolved: false, message: 'no such host' } })).text,
    ).toBe('unresolved');
    // VACUITY CONTROLS — a SOCKS5 row with a resolved pre-flight, and a VPN
    // row with no pre-flight at all, both stay arm 7.
    expect(healthPill(props({ ...ok, vpn: false, probed: true })).text).toBe('not measured');
    expect(healthPill(props({ ...ok, endpoint: null })).text).toBe('not measured');
    expect(healthPill(props({ ...ok, endpoint: undefined })).text).toBe('not measured');
    // (p) D1 — the words are the grid's EndpointHealthPill: both surfaces read
    // the SAME constants from lib/proxy-check-copy (the grid once carried the
    // literals; a retyped sentence there would drift unseen).
    expect(ENDPOINT_OK_PILL).toBe('endpoint ok');
    expect(source('views/ProxiesView.tsx')).toContain('{ENDPOINT_OK_PILL}');
    expect(source('views/ProxiesView.tsx')).toContain('title={ENDPOINT_OK_TITLE}');
    expect(source('views/ProxiesView.tsx')).not.toContain(ENDPOINT_OK_TITLE);
  });

  it('(o) arm 3b — an endpoint pre-flight that did NOT resolve → "unresolved" · broken · error · title = the resolver’s message; outranks testing, untested, the number and arm 7', () => {
    // healthPill arm 3b (`endpointUnresolved(p)`): deleting it lets the row fall
    // to arm 7 → 'not measured' + a "no exit yet — run Check VPN" title → reds.
    const unresolved = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      flag: '🌍',
      endpoint: { resolved: false, message: 'DNS lookup of wg.example.com failed: no such host.' },
    };
    const { container } = render(<ProfilePhoneCard {...props(unresolved)} />);
    const el = pill(container);
    expect(el.textContent).toBe(ENDPOINT_UNRESOLVED);
    expect(el.textContent).toBe('unresolved');
    expect(el.getAttribute('data-health')).toBe('broken');
    expect(classes(el)).toContain('text-[#fca5a5]');
    expect(el.getAttribute('title')).toBe('DNS lookup of wg.example.com failed: no such host.');
    expect(container.textContent).not.toMatch(/not measured/);
    expect(container.textContent).not.toMatch(/untested/);
    cleanup();
    expect(healthPill(props({ ...unresolved, testing: true })).text).toBe('unresolved');
    expect(healthPill(props({ ...unresolved, probed: false })).text).toBe('unresolved');
    expect(healthPill(props({ ...unresolved, latencyMs: 12 })).text).toBe('unresolved');
    // An HTTP row (not vpn) with the same pre-flight reads the same word.
    expect(healthPill(props({ ...unresolved, vpn: false })).text).toBe('unresolved');
    // An empty resolver message still yields a title (the exit sentence).
    expect(
      healthPill(props({ ...unresolved, endpoint: { resolved: false, message: '' } })).title,
    ).toBe(ENDPOINT_UNRESOLVED_EXIT_TITLE);
    // Arms 2 and 3 outrank it (a failed SOCKS5 / a tunnel the test Mac could not bring up).
    expect(healthPill(props({ ...unresolved, vpnFailure: VPN_DOWN })).text).toBe('VPN tunnel down');
    expect(healthPill(props({ ...unresolved, vpn: false, capabilities: NOT_REACHABLE })).text).toBe(
      'Not reachable',
    );
    // VACUITY CONTROLS — a RESOLVED pre-flight is not this arm (polish: it is
    // arm 6c, 'endpoint ok'); neither is an absent one.
    expect(
      healthPill(props({ ...unresolved, endpoint: { resolved: true, message: 'Resolved' } })).text,
    ).toBe('endpoint ok');
    expect(healthPill(props({ ...unresolved, endpoint: null })).text).toBe('not measured');
    expect(healthPill(props({ ...unresolved, endpoint: undefined })).text).toBe('not measured');
  });
});

describe('B2 — pill vocabulary pin: every reachable string ≤ 15 chars and verbatim in its source of truth', () => {
  // A parity pin: it asserts each VALUE and where it comes from, never that
  // 15 chars is enough (the gate measures that). Rewording a pill without its
  // source (or vice versa) reds here.
  const arms: Array<{ p: Partial<ProfilePhoneCardProps>; text: string; source: string }> = [
    { p: { hasProxy: false }, text: 'no proxy', source: 'components/ProfilesTable.tsx' },
    { p: { capabilities: NOT_REACHABLE }, text: 'Not reachable', source: 'lib/proxies.ts' },
    {
      p: { capabilities: { ...NOT_REACHABLE, reachable: true } },
      text: 'Auth failed',
      source: 'lib/proxies.ts',
    },
    { p: { capabilities: CANNOT_ROUTE }, text: 'Cannot route', source: 'lib/proxies.ts' },
    {
      p: { vpn: true, capabilities: null, vpnFailure: 'x' },
      text: 'VPN tunnel down',
      source: 'components/ProfilesTable.tsx',
    },
    { p: { testing: true }, text: 'Testing…', source: 'views/ProxiesView.tsx' },
    { p: { testing: true, vpn: true }, text: 'Checking…', source: 'views/ProxiesView.tsx' },
    {
      p: { probed: false, capabilities: null },
      text: 'untested',
      source: 'components/ProfilesTable.tsx',
    },
    { p: { latencyMs: 4242 }, text: '4242ms', source: 'components/ProfilesTable.tsx' },
    {
      p: { vpn: true, capabilities: null, latencyMs: null },
      text: 'not measured',
      source: 'lib/proxy-check-copy.ts',
    },
    // (o) — the two grid-only states: their words are the Proxies grid's EndpointHealthPill.
    {
      p: {
        vpn: true,
        capabilities: null,
        latencyMs: null,
        endpoint: { resolved: false, message: 'x' },
      },
      text: 'unresolved',
      source: 'views/ProxiesView.tsx',
    },
    {
      p: {
        vpn: true,
        capabilities: null,
        latencyMs: null,
        latencyVantage: { measuredFrom: 'fleet' },
      },
      text: 'tunnel up',
      source: 'views/ProxiesView.tsx',
    },
    {
      p: {
        vpn: true,
        capabilities: null,
        latencyMs: null,
        endpoint: { resolved: true, message: 'Resolved' },
      },
      text: 'endpoint ok',
      source: 'views/ProxiesView.tsx',
    },
  ];
  for (const arm of arms) {
    it(`"${arm.text}" (≤ 15 chars) is the card's word and appears verbatim in ${arm.source}`, () => {
      expect(healthPill(props(arm.p)).text).toBe(arm.text);
      expect(arm.text.length).toBeLessThanOrEqual(15);
      // `${n}ms` is a template in both files; pin the shape, not a number.
      const needle = arm.text === '4242ms' ? '}ms' : arm.text;
      expect(source(arm.source)).toContain(needle);
    });
  }
  it('the session words are the list’s', () => {
    expect(source('components/ProfilesTable.tsx')).toContain("{r.running ? 'Live' : 'Idle'}");
    expect(source('components/ProfilesTable.tsx')).toContain('Launching…');
  });
});

describe('B3 — the caps row: ≤ 3 measured chips + "+N", cut by the static width table (visibleChips)', () => {
  const MAX = props({
    folder: 'Shopping / Netherlands',
    tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
    locationLabel: 'Amsterdam, North Holland, Netherlands',
    osFingerprint: REAL_OS,
  });

  it('visibleChips: MAX (UDP ✓ 45 + QUIC ~ 47 + ✓ iOS/macOS 78 + gaps 8 = 178, the RENDERED widths) → 2 + "+1" at 144 AND at 152 (the 186px column), all 3 at 206', () => {
    // ProfilePhoneCard.tsx `visibleChips` loop: dropping the `+ OVERFLOW_PILL_WIDTH`
    // reservation, or the width table's 78 for the OS chip, lets 3 fit at 144 → reds.
    // Polish — CHIP_WIDTH is pinned to the live render (scratchpad/polish-chips.mjs:
    // 44.22 / 46.03 / 77.38 px at 9.5px semibold): the old 32/38/68 summed to 146
    // ≤ 152, so the 1440px viewport's 186px column showed all three and the row's
    // overflow-hidden cut the OS chip mid-glyph. Lowering any literal below its
    // rendered width reds the 152 arm.
    const at144 = visibleChips(MAX, 144);
    expect(at144.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~']);
    expect(at144.hiddenHints).toHaveLength(1);
    expect(at144.hiddenHints[0]).toMatch(/^✓ iOS\/macOS — Proxy stack looks like iOS\/macOS/);
    const at152 = visibleChips(MAX, 152);
    expect(at152.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~']);
    expect(at152.hiddenHints).toHaveLength(1);
    const at206 = visibleChips(MAX, 206);
    expect(at206.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~', '✓ iOS/macOS']);
    expect(at206.chips.map((c) => c.width)).toEqual([45, 47, 78]);
    expect(at206.hiddenHints).toEqual([]);
    expect(visibleChips(MAX, 226).chips).toHaveLength(3);
    // The '+1' tail reserves 27px (dashed border + 9.5px): 45 + 47 + 4 + 4 + 27 = 127.
    expect(visibleChips(MAX, 127).chips).toHaveLength(2);
    expect(visibleChips(MAX, 126).chips).toHaveLength(1);
    // Every other measured chip, pinned to its render as well.
    const widths = (over: Partial<ProfilePhoneCardProps>) =>
      Object.fromEntries(visibleChips(props(over), 400).chips.map((c) => [c.text, c.width]));
    expect(widths({ quicMeasured: 'h3' })).toMatchObject({ 'QUIC ✓': 49 });
    expect(widths({ quicMeasured: 'h2-only' })).toMatchObject({ '⤵ QUIC': 48 });
    expect(
      widths({ capabilities: { ...props().capabilities!, udp_associate: false } }),
    ).toMatchObject({
      '⤵ UDP': 44,
    });
    expect(widths({ testing: true })).toMatchObject({ '… OS': 38 });
    // Fixed order is UDP → QUIC → OS whatever fits.
    expect(visibleChips(MAX, 40).chips.map((c) => c.text)).toEqual([]);
    expect(visibleChips(MAX, 40).hiddenHints).toHaveLength(3);
  });

  it('the rendered row has ≤ 3 chip children plus an optional caps-overflow whose title lists every hidden hint', () => {
    const { container } = render(<ProfilePhoneCard {...MAX} />);
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('measured');
    const overflow = byComponent(caps, 'caps-overflow');
    const chipEls = Array.from(caps.children).filter((c) => c !== overflow);
    expect(chipEls.length).toBeLessThanOrEqual(3);
    // jsdom measures 0px, so the card keeps DEFAULT_CONTENT_WIDTH (206): all three fit.
    expect(DEFAULT_CONTENT_WIDTH).toBe(206);
    expect(chipEls).toHaveLength(3);
    expect(overflow).toBeNull();
    cleanup();
  });

  it('the row reads its OWN width: at a measured 144px MAX renders UDP ✓ · QUIC ~ · +1 (the OS chip displaced into the "+1" title)', () => {
    // ProfilePhoneCard.tsx `useContentWidth`: replacing the measured `el.clientWidth`
    // with the constant makes this arm red (3 chips render at a 144px row).
    const proto = Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('data-region') === 'status' ? 144 : 0;
      },
    });
    try {
      const { container } = render(<ProfilePhoneCard {...MAX} />);
      const caps = byRegion(container, 'caps') as HTMLElement;
      const overflow = byComponent(caps, 'caps-overflow') as HTMLElement;
      expect(overflow).not.toBeNull();
      expect(overflow.textContent).toBe('+1');
      expect(overflow.getAttribute('title')).toMatch(/iOS\/macOS/);
      expect(byComponent(caps, 'proxy-os-fingerprint')).toBeNull();
      const texts = Array.from(caps.children)
        .filter((c) => c !== overflow)
        .map((c) => c.textContent);
      expect(texts).toEqual(['UDP ✓', 'QUIC ~']);
      cleanup();
    } finally {
      if (original !== undefined) Object.defineProperty(proto, 'clientWidth', original);
      else Reflect.deleteProperty(proto, 'clientWidth');
    }
  });

  it('a measured UDP fall-back is muted, never red (C4): no [data-udp="false"] carries text-status-error', () => {
    // `capabilityChips` UDP className: restoring `bg-status-error/20 text-status-error`
    // for `!udpOk` reds this.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ capabilities: { ...props().capabilities!, udp_associate: false } })}
      />,
    );
    const udp = container.querySelector('[data-udp="false"]') as HTMLElement;
    expect(udp).not.toBeNull();
    expect(udp.textContent).toBe('⤵ UDP');
    expect(classes(udp)).not.toContain('text-status-error');
    // Polish — one fill + one ink for every non-green chip (the comp's
    // translucent slate + ink2; the near-black inset is gone), and the
    // inferred 'QUIC ~' beside it wears exactly the same pair — a guess must
    // not read brighter than a measured negative.
    expect(classes(udp)).toEqual(expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']));
    expect(classes(udp)).not.toContain('bg-surface-inset');
    // (No UDP relay → the QUIC chip is the measured negative '⤵ QUIC' here;
    // the inferred '~' chip is pinned to the same pair in the QUIC arm below.)
    const quic = container.querySelector('[data-quic-inferred]') as HTMLElement;
    expect(quic.textContent).toBe('⤵ QUIC');
    expect(classes(quic).filter((c) => /^(bg|text)-/.test(c))).toEqual(
      classes(udp).filter((c) => /^(bg|text)-/.test(c)),
    );
    // And the healthy pill beside it stays green — no red anywhere on a working proxy.
    expect(container.querySelector('.text-status-error')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('*')).some((el) =>
        classes(el).includes('text-[#fca5a5]'),
      ),
    ).toBe(false);
    cleanup();
  });

  it('a VPN row renders no [data-udp] chip; "UDP via tunnel" + its sentence ride in the "+N" title; a measured relay verdict is its QUIC chip', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: 61, quicProbe: true })}
      />,
    );
    expect(container.querySelector('[data-udp]')).toBeNull();
    const caps = byRegion(container, 'caps') as HTMLElement;
    const quic = caps.querySelector('[data-quic-inferred]') as HTMLElement;
    expect(quic.textContent).toBe('QUIC ✓');
    expect(quic.getAttribute('data-quic-inferred')).toBe('false');
    const overflow = byComponent(caps, 'caps-overflow') as HTMLElement;
    expect(overflow.getAttribute('title')).toMatch(
      /UDP via tunnel — UDP travels inside the VPN tunnel/,
    );
    cleanup();
    // No relay measurement → no QUIC chip either (eligibility = a measurement).
    const { container: none } = render(
      <ProfilePhoneCard {...props({ vpn: true, capabilities: null, latencyMs: 61 })} />,
    );
    expect(none.querySelector('[data-quic-inferred]')).toBeNull();
    cleanup();
  });

  it('an unmeasured OS renders no proxy-os-fingerprint chip in the row — its hint is in the "+N" title; a REAL reading is a chip', () => {
    // `capabilityChips` OS eligibility: admitting tone 'unknown' reds the first
    // half (a '— OS' placeholder chip); dropping the match tone reds the second.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(byComponent(caps, 'proxy-os-fingerprint')).toBeNull();
    expect(byComponent(caps, 'caps-overflow')?.getAttribute('title')).toMatch(
      /^OS — Stack OS not measured/,
    );
    cleanup();
    const { container: real } = render(<ProfilePhoneCard {...props({ osFingerprint: REAL_OS })} />);
    const chip = byComponent(
      byRegion(real, 'caps') as HTMLElement,
      'proxy-os-fingerprint',
    ) as HTMLElement;
    expect(chip.getAttribute('data-os-tone')).toBe('match');
    cleanup();
  });

  it('the QUIC chip keeps [data-quic-inferred]: "~" inferred (muted), "✓" measured (green), "⤵" measured negative (muted, never red)', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const inferred = container.querySelector('[data-quic-inferred="true"]') as HTMLElement;
    expect(inferred.textContent).toBe('QUIC ~');
    expect(classes(inferred)).not.toContain('text-status-ready');
    // Polish — a guess wears the SAME fill + ink as a measured negative.
    expect(classes(inferred)).toEqual(
      expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']),
    );
    cleanup();
    const { container: h3 } = render(<ProfilePhoneCard {...props({ quicMeasured: 'h3' })} />);
    const green = h3.querySelector('[data-quic-inferred="false"]') as HTMLElement;
    expect(green.textContent).toBe('QUIC ✓');
    expect(classes(green)).toContain('text-status-ready');
    cleanup();
    const { container: h2 } = render(<ProfilePhoneCard {...props({ quicMeasured: 'h2-only' })} />);
    const neg = h2.querySelector('[data-quic-inferred="false"]') as HTMLElement;
    expect(neg.textContent).toBe('⤵ QUIC');
    expect(classes(neg)).not.toContain('text-status-error');
    cleanup();
  });
});

describe('B4 — row budgets: fixed heights, no aspect ratio, no scrolling body, regions in order, dock outside', () => {
  const BUDGET_CLASS: Readonly<Record<string, string>> = {
    identity: 'h-[38px]',
    status: 'h-5',
    exit: 'h-[18px]',
    via: 'h-4',
    caps: 'h-5',
    when: 'h-[14px]',
    meta: 'h-4',
  };
  const ORDER = ['identity', 'status', 'exit', 'via', 'caps', 'when', 'meta'];

  it('every [data-region] carries its h-* class, shrink-0 and overflow-hidden; the DOM order is identity, status, exit, via, caps, when, meta', () => {
    // Each region div in ProfilePhoneCard.tsx: dropping any of the three tokens
    // (or reordering two regions) reds this — and reds the Playwright budget.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const regions = Array.from(container.querySelectorAll('[data-region]'));
    expect(regions.map((r) => r.getAttribute('data-region'))).toEqual(ORDER);
    for (const r of regions) {
      const name = r.getAttribute('data-region') as string;
      expect(classes(r), name).toEqual(
        expect.arrayContaining([BUDGET_CLASS[name], 'shrink-0', 'overflow-hidden', 'flex']),
      );
    }
    cleanup();
  });

  it('the screen is a fixed 220px with NO aspect-* class; the body is overflow-hidden and never overflow-y-auto', () => {
    // Screen div: `h-[220px]` back to `aspect-[9/18.5]` reds arm 1 (the Phase B
    // root cause). Body div: `overflow-y-auto` back reds arm 2.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const screenEl = byComponent(container, 'phone-screen');
    expect(classes(screenEl).some((c) => /^aspect-/.test(c))).toBe(false);
    expect(classes(screenEl)).toEqual(
      expect.arrayContaining(['h-[220px]', 'overflow-hidden', 'flex-col']),
    );
    const body = byComponent(container, 'card-body');
    expect(classes(body)).toContain('overflow-hidden');
    expect(classes(body)).not.toContain('overflow-y-auto');
    expect(classes(body)).not.toContain('overflow-auto');
    cleanup();
  });

  it('the dock and the Launch button are outside the body; every region is inside it', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const body = byComponent(container, 'card-body') as HTMLElement;
    const dock = byComponent(container, 'card-dock') as HTMLElement;
    expect(dock).not.toBeNull();
    expect(body.contains(dock)).toBe(false);
    expect(body.contains(screen.getByRole('button', { name: 'Launch' }))).toBe(false);
    for (const r of container.querySelectorAll('[data-region]'))
      expect(body.contains(r)).toBe(true);
    // The old phone furniture is gone: no island, no home indicator, no 44px avatar.
    expect(container.querySelector('.h-11.w-11')).toBeNull();
    expect(container.querySelector('.w-\\[42px\\]')).toBeNull();
    cleanup();
  });
});

describe('B5 — failure states: the repair row is two buttons and nothing else; the pill carries the words', () => {
  it('a failed SOCKS5 renders proxy-broken-banner INSIDE [data-region="caps"] with Retest + Change and no text besides the buttons', () => {
    // R5 mode B in ProfilePhoneCard.tsx: re-adding the label span inside the
    // banner (the Phase A shape) reds the no-text arm; moving the banner out of
    // the caps region reds the containment arm.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: CANNOT_ROUTE, onEdit: vi.fn() })}
      />,
    );
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('repair');
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    expect(caps.contains(banner)).toBe(true);
    expect(banner.querySelector('[data-action="retest-proxy"]')).not.toBeNull();
    expect(banner.querySelector('[data-action="change-proxy"]')).not.toBeNull();
    for (const node of Array.from(banner.childNodes)) {
      expect(node.nodeType).toBe(Node.ELEMENT_NODE);
      expect((node as Element).tagName).toBe('BUTTON');
    }
    expect(banner.getAttribute('data-vpn-failure')).toBe('false');
    // The verdict word is the pill's, exactly once on the card.
    expect(screen.getAllByText('Cannot route')).toHaveLength(1);
    expect(screen.getByText('Cannot route').getAttribute('data-component')).toBe('health-pill');
    for (const b of banner.querySelectorAll('button')) {
      expect(classes(b)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    }
    cleanup();
  });

  it('a VPN failure: the Retest button reads RECHECK_ACTION, "Checking…" while in flight; data-vpn-failure="true"', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: VPN_DOWN,
          onEdit: vi.fn(),
        })}
      />,
    );
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    expect(banner.getAttribute('data-vpn-failure')).toBe('true');
    expect(screen.getByRole('button', { name: RECHECK_ACTION })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: VPN_DOWN,
          onEdit: vi.fn(),
          testing: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    cleanup();
  });

  it('(o) an UNRESOLVED endpoint is a repair row (Re-check + Change, data-vpn-failure="false"), never the first-measurement "Check VPN"; the exit line says why with no "run Check VPN" promise', () => {
    // capsMode's `endpointUnresolved(p)` clause: deleting it drops the row to
    // mode C — a 'Check VPN' button under a red 'unresolved' pill → reds. The
    // exit derivation's unresolved branch: deleting it restores the
    // VPN_NO_EXIT_YET_TITLE ("Run Check VPN to bring the tunnel up") → reds.
    const unresolved = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      flag: '🌍',
      endpoint: { resolved: false, message: 'DNS lookup failed' },
      onEdit: vi.fn(),
    };
    expect(capsMode(props(unresolved))).toBe('repair');
    const { container } = render(<ProfilePhoneCard {...props(unresolved)} />);
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('repair');
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    expect(caps.contains(banner)).toBe(true);
    expect(banner.getAttribute('data-vpn-failure')).toBe('false');
    expect(screen.getByRole('button', { name: RECHECK_ACTION })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: CHECK_VPN_ACTION })).toBeNull();
    expect(container.textContent).not.toContain('🌍');
    const exitText = screen.getByText(VPN_NO_EXIT_YET_SHORT);
    expect(exitText.getAttribute('title')).toBe(ENDPOINT_UNRESOLVED_EXIT_TITLE);
    expect(exitText.getAttribute('title')).not.toBe(VPN_NO_EXIT_YET_TITLE);
    expect(container.querySelector('[title*="bring the tunnel up on the test Mac"]')).toBeNull();
    cleanup();
    // An HTTP row with the same pre-flight: 'no exit IP' with the same title, and Re-check (a pre-flight re-runs).
    render(<ProfilePhoneCard {...props({ ...unresolved, vpn: false, onEdit: undefined })} />);
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe(
      ENDPOINT_UNRESOLVED_EXIT_TITLE,
    );
    expect(screen.getByRole('button', { name: RECHECK_ACTION })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retest' })).toBeNull();
    cleanup();
    // VACUITY CONTROL — a resolved pre-flight on a VPN row with nothing measured is still mode C.
    expect(
      capsMode(props({ ...unresolved, endpoint: { resolved: true, message: 'Resolved' } })),
    ).toBe('first');
  });
});

describe('B6 — the exit line', () => {
  it('no "🌍" anywhere when exitIp and countryCode are null (G12): a 13px dashed placeholder ring and the SHORT clause instead', () => {
    // R3: rendering `p.flag` unconditionally (the v3 shape) reds this — the
    // parent passes '🌍' for "no exit" and the glyph asserted one. Polish: the
    // placeholder is the comp's dashed ring of the flag's width (the ◌ glyph
    // rendered as a 6px speck).
    const { container } = render(
      <ProfilePhoneCard
        {...props({ flag: '🌍', exitIp: null, countryCode: null, probed: true })}
      />,
    );
    expect(container.textContent).not.toContain('🌍');
    const exit = byRegion(container, 'exit') as HTMLElement;
    expect(exit.textContent).not.toContain('◌');
    const ring = byComponent(exit, 'exit-placeholder') as HTMLElement;
    expect(ring).not.toBeNull();
    expect(classes(ring)).toEqual(
      expect.arrayContaining(['h-[13px]', 'w-[13px]', 'rounded-full', 'border-dashed', 'shrink-0']),
    );
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe(
      'No exit was measured by the last test — run Test proxy again',
    );
    cleanup();
    // A known exit renders the flag and no placeholder.
    const { container: known } = render(<ProfilePhoneCard {...props()} />);
    expect(byComponent(byRegion(known, 'exit') as HTMLElement, 'exit-placeholder')).toBeNull();
    cleanup();
  });

  it('the exit text carries `place · ip` as its title and reads the place; the flag renders when an exit is known', () => {
    const { container } = render(
      <ProfilePhoneCard {...props({ locationLabel: 'Amsterdam, North Holland' })} />,
    );
    const text = screen.getByText('Amsterdam, North Holland');
    expect(text.getAttribute('title')).toBe('Amsterdam, North Holland · 82.14.220.9');
    expect(classes(text)).toEqual(expect.arrayContaining(['truncate', 'min-w-0', 'flex-1']));
    expect((byRegion(container, 'exit') as HTMLElement).textContent).toContain('🇳🇱');
    expect(container.querySelector('[data-region="exit"] .mono')).toBeNull();
    cleanup();
  });

  it('a VPN with no exit reads VPN_NO_EXIT_YET_SHORT with VPN_NO_EXIT_YET_TITLE; a failed exit probe reads EXIT_GEO_UNAVAILABLE_SHORT with its title; the long forms are byte-identical to today', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          countryCode: null,
        })}
      />,
    );
    const vpnText = screen.getByText(VPN_NO_EXIT_YET_SHORT);
    expect(vpnText.getAttribute('title')).toBe(VPN_NO_EXIT_YET_TITLE);
    expect(classes(vpnText)).toContain('italic');
    expect(container.textContent).not.toContain('no exit IP');
    cleanup();
    render(
      <ProfilePhoneCard {...props({ exitIp: null, countryCode: null, exitProbeFailed: true })} />,
    );
    expect(screen.getByText(EXIT_GEO_UNAVAILABLE_SHORT).getAttribute('title')).toBe(
      EXIT_GEO_UNAVAILABLE_TITLE,
    );
    cleanup();
    // G8 — the copy pins: the grid's full sentences derive from the SHORT halves.
    expect(VPN_NO_EXIT_YET).toBe('no exit measured yet — run Check VPN');
    expect(VPN_NO_EXIT_YET).toBe(`${VPN_NO_EXIT_YET_SHORT} — run ${CHECK_VPN_ACTION}`);
    expect(EXIT_GEO_UNAVAILABLE).toBe('exit geo unavailable — the probe did not complete');
    expect(EXIT_GEO_UNAVAILABLE).toBe(`${EXIT_GEO_UNAVAILABLE_SHORT} — the probe did not complete`);
    expect(EXIT_GEO_UNAVAILABLE_TITLE).toBe(
      'The proxy connected and authenticated, but no traffic completed a round trip through it.',
    );
    // The grid renders the full sentence from the SAME constants (it imports
    // them from lib/proxy-check-copy — the grid follow-up landed): pin the use,
    // never a retyped literal.
    expect(source('views/ProxiesView.tsx')).toMatch(/\{EXIT_GEO_UNAVAILABLE\}/);
    expect(source('views/ProxiesView.tsx')).toMatch(/\bEXIT_GEO_UNAVAILABLE_TITLE\b/);
  });
});

describe('B7 — mode C, the first measurement is one click on the card (list parity)', () => {
  it('an untested SOCKS5 renders a "Test" button (data-action=retest-proxy) that calls onTest and does not select', () => {
    // R5 mode C: dropping the button (Phase A had no inline Test on untested
    // rows) reds this; dropping its stopPropagation reds the select arm.
    const onTest = vi.fn();
    const onToggleSelect = vi.fn();
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          probed: false,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          onTest,
          onToggleSelect,
        })}
      />,
    );
    expect(capsMode(props({ probed: false, capabilities: null, latencyMs: null }))).toBe('first');
    const btn = screen.getByRole('button', { name: 'Test' });
    expect(btn.getAttribute('data-action')).toBe('retest-proxy');
    expect((byRegion(container, 'caps') as HTMLElement).contains(btn)).toBe(true);
    expect(btn.getAttribute('title')).toBe(
      'Test proxy from this Mac — reachability, latency, exit IP',
    );
    // No chip before a measurement; the OS-not-measured hint rides in '+1'.
    expect(container.querySelector('[data-udp], [data-quic-inferred]')).toBeNull();
    expect(byComponent(container, 'caps-overflow')?.getAttribute('title')).toMatch(
      /^OS — Stack OS not measured/,
    );
    fireEvent.click(btn);
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
    cleanup();
  });

  it('a VPN with no verdict renders CHECK_VPN_ACTION; while testing the button keeps its word, disabled (the pill says Checking…)', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          probed: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOTICE,
        })}
      />,
    );
    const btn = screen.getByRole('button', { name: CHECK_VPN_ACTION });
    expect(btn.getAttribute('title')).toBe(CHECK_VPN_TITLE);
    expect((byRegion(container, 'caps') as HTMLElement).contains(btn)).toBe(true);
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          probed: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOTICE,
          testing: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: CHECK_VPN_ACTION })).toBeDisabled();
    expect(pill(container).textContent).toBe('Checking…');
    // The list's '…' while testing is NOT used here: the caps row is the word
    // (plus the '+N' that keeps the tunnel/OS facts reachable before any test).
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.textContent).toMatch(/^Check VPN\+\d$/);
    expect(byComponent(caps, 'caps-overflow')?.getAttribute('title')).toMatch(/UDP via tunnel/);
    expect(byComponent(caps, 'caps-overflow')?.getAttribute('title')).toMatch(
      /^OS — .*VPN tunnel/m,
    );
    cleanup();
  });

  it('no proxy renders neither button, EMPTY via + caps rows that keep their height (polish: two stacked "—" read as broken data), and the menu has no Test row', () => {
    const { container } = render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    expect(container.querySelector('[data-action="retest-proxy"]')).toBeNull();
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.textContent).toBe('');
    expect(classes(caps)).toContain('h-5');
    const via = byRegion(container, 'via') as HTMLElement;
    expect(via.textContent).toBe('');
    expect(classes(via)).toContain('h-4');
    expect(screen.queryByLabelText(/Test proxy from this Mac/)).toBeNull();
    expect(screen.queryByLabelText(CHECK_VPN_TITLE)).toBeNull();
    cleanup();
  });
});

describe('B8 — every truncating text is titled', () => {
  it('name, device, exit text, proxy label, VPN failure, VPN notice, meta pills and the note glyph all carry a non-empty title', () => {
    const name = 'amsterdam shopper with a long descriptive profile name';
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          name,
          proxyName: 'Oxylabs residential NL rotating #3',
          proxyAddress: '10.0.0.5:1080',
          locationLabel: 'Amsterdam, North Holland, Netherlands',
          folder: 'Shopping / Netherlands',
          tags: ['retail', 'a-very-long-tag-name-x'],
          note: 'Warm before 09:00 CET',
          onSaveNote: vi.fn(),
        })}
      />,
    );
    expect(screen.getByText(name).getAttribute('title')).toBe(name);
    expect(screen.getByText('iPhone 17').getAttribute('title')).toBe('iPhone 17');
    expect(screen.getByText('Amsterdam, North Holland, Netherlands').getAttribute('title')).toBe(
      'Amsterdam, North Holland, Netherlands · 82.14.220.9',
    );
    // N8/C7 — the via row's title is `name — host:port`.
    const via = byComponent(container, 'profile-card-proxy-name') as HTMLElement;
    expect(byRegion(container, 'via')).toBe(via);
    expect(screen.getByText('Oxylabs residential NL rotating #3').getAttribute('title')).toBe(
      'Oxylabs residential NL rotating #3 — 10.0.0.5:1080',
    );
    expect(screen.getByText('📁 Shopping / Netherlands').getAttribute('title')).toBe(
      'Shopping / Netherlands',
    );
    const note = byComponent(container, 'profile-note') as HTMLElement;
    expect(note.getAttribute('title')).toBe('Warm before 09:00 CET — Click to edit note');
    for (const el of container.querySelectorAll('.truncate')) {
      expect(el.closest('[title]'), `untitled truncate: ${el.textContent ?? ''}`).not.toBeNull();
    }
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: VPN_DOWN,
        })}
      />,
    );
    // The override line's title opens with the full sentence and carries the
    // last-used / checked facts it displaced (polish: the never-launched fact
    // is its title sentence, and the LINE shows the cause, not the preamble).
    expect(byComponent(container, 'proxy-vpn-failure')?.getAttribute('title')).toBe(
      `${VPN_DOWN} · This profile has never been launched`,
    );
    expect(byComponent(container, 'proxy-vpn-failure')?.textContent).toBe(
      'handshake timed out after 20 s.',
    );
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOTICE,
          checkedAtIso: '2026-06-15T06:30:00.000Z',
        })}
      />,
    );
    const notice = byComponent(container, 'proxy-vpn-notice') as HTMLElement;
    expect(
      notice
        .getAttribute('title')
        ?.startsWith(`${VPN_NOTICE} · This profile has never been launched · Checked: `),
    ).toBe(true);
    expect(notice.getAttribute('data-checked-at')).toBe('2026-06-15T06:30:00.000Z');
    expect(byComponent(container, 'proxy-checked-at')).toBeNull();
    cleanup();
  });

  it('the via row falls back to host:port (mono) when the proxy has no label, and the 🗒 glyph opens the note editor', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          proxyName: null,
          proxyAddress: '10.0.0.5:1080',
          note: 'vip',
          onSaveNote: vi.fn(),
        })}
      />,
    );
    const addr = screen.getByText('10.0.0.5:1080');
    expect(classes(addr)).toContain('mono');
    expect(byComponent(container, 'profile-card-proxy-name')).not.toBeNull();
    fireEvent.click(byComponent(container, 'profile-note') as HTMLElement);
    expect(screen.getByLabelText('Note for amsterdam shopper')).toBeTruthy();
    cleanup();
  });
});

describe('B9 — dock + menu', () => {
  it('launching → the button is named "Launching…" with aria-busy; the Launch button truncates with nowrap', () => {
    render(<ProfilePhoneCard {...props({ busy: true, launching: true })} />);
    const btn = screen.getByRole('button', { name: 'Launching…' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(classes(btn)).toEqual(
      expect.arrayContaining(['min-w-0', 'truncate', 'whitespace-nowrap', 'flex-1']),
    );
    cleanup();
  });

  it('the menu has no row captioned "Watch" or "View live" (D8) and no w-44; the other rows are unchanged', () => {
    // Menu in ProfilePhoneCard.tsx: re-adding the `p.onWatch` MenuRow reds the
    // first arm; `w-44` back reds the second.
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          running: true,
          onStop: vi.fn(),
          onAssist: vi.fn(),
          onEdit: vi.fn(),
          onSaveNote: vi.fn(),
          onClone: vi.fn(),
          onActivity: vi.fn(),
          onExport: vi.fn(),
          onTrim: vi.fn(),
          onDelete: vi.fn(),
        })}
      />,
    );
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    const captions = Array.from(menu.querySelectorAll('button')).map(
      (b) => b.textContent?.trim() ?? '',
    );
    expect(captions.some((c) => /Watch|View live/.test(c))).toBe(false);
    expect(screen.queryByLabelText(/Launch and watch live|Open the live view/)).toBeNull();
    expect(classes(menu)).not.toContain('w-44');
    expect(classes(menu).some((c) => /^w-(\d|\[)/.test(c) && c !== 'w-auto')).toBe(false);
    expect(classes(menu)).toEqual(
      expect.arrayContaining([
        // Phase C: a fixed box in the viewport (portaled) — never `absolute`
        // inside the card, where the grid's scroller could clip it.
        'fixed',
        'z-50',
        // Polish: 350 — the 13-row real-app maximum (344px) has no fold; at
        // 260 'Clear everything' and 'Delete' sat under an invisible scrollbar.
        'max-h-[350px]',
        'overflow-y-auto',
      ]),
    );
    expect(classes(menu)).not.toContain('absolute');
    const labels = Array.from(menu.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    // Polish (WCAG 2.5.3): a row's accessible name opens with its visible caption.
    // Phase C: the Details row is FIRST (the sheet is the card's depth).
    expect(labels).toEqual([
      'Details — every fact about amsterdam shopper, in full',
      'Ask the AI assistant about amsterdam shopper',
      "Stop session — end amsterdam shopper's running session",
      'Test proxy from this Mac — reachability, latency, exit IP',
      'Edit amsterdam shopper',
      'Edit note for amsterdam shopper',
      'Duplicate amsterdam shopper',
      'Activity — recent pages opened with amsterdam shopper',
      'Export amsterdam shopper as a portable JSON copy',
      'Clearing options for amsterdam shopper',
      'Delete amsterdam shopper',
    ]);
    // Phase C: the menu is a PORTAL — no descendant of the article at all (it
    // used to be a sibling of the screen, which escaped the screen's clip but
    // not the grid's), a direct child of document.body.
    expect(byComponent(container, 'phone-screen')?.contains(menu)).toBe(false);
    expect(container.querySelector('article')?.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    cleanup();
  });

  it('the menu opens DOWNWARD when fewer than 360px (polish: was 320, the menu grew to 350) of room lie above the dock, UPWARD otherwise (data-placement)', () => {
    // `toggleMenu` in ProfilePhoneCard.tsx: dropping the `roomAbove(...) < MENU_FLIP_ROOM_PX`
    // computation pins one placement for both arms → one of them reds.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored verbatim in `finally`
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rectAt = (top: number): DOMRect => ({
      top,
      bottom: top + 47,
      left: 0,
      right: 178,
      width: 178,
      height: 47,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    try {
      HTMLElement.prototype.getBoundingClientRect = () => rectAt(120);
      const { unmount } = render(<ProfilePhoneCard {...props()} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const below = byComponent(document, 'card-actions-menu') as HTMLElement;
      expect(below.getAttribute('data-placement')).toBe('below');
      // Phase C (`menuBoxFor`): a FIXED box from the card's rect — 6px below
      // the card's bottom edge, inset 6px from both card edges (Phase A's
      // "anchored to both edges", now in viewport coordinates); no `bottom`.
      // Polish: those 6px are from the PADDING box; jsdom lays out no border
      // (clientLeft/offsetWidth 0), so here the padding box is the rect — the
      // 1px case is pinned in the sheet file's `menuBoxFor` arms.
      expect(below.style.top).toBe('173px'); // rect bottom 167 + 6
      expect(below.style.bottom).toBe('');
      expect(below.style.left).toBe('6px');
      expect(below.style.width).toBe('166px'); // 178 − 2 × 6
      expect(classes(below)).not.toContain('top-full');
      expect(classes(below)).not.toContain('bottom-[59px]');
      unmount();

      HTMLElement.prototype.getBoundingClientRect = () => rectAt(600);
      render(<ProfilePhoneCard {...props()} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const above = byComponent(document, 'card-actions-menu') as HTMLElement;
      expect(above.getAttribute('data-placement')).toBe('above');
      // Above: the menu's bottom sits 6px above the dock's top (rect top 600).
      expect(above.style.bottom).toBe(`${String(window.innerHeight - (600 - 6))}px`);
      expect(above.style.top).toBe('');
      expect(classes(above)).not.toContain('bottom-[59px]');
      cleanup();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it('the "when" row: running + runningSinceIso → "running <elapsed>" titled "Running since …"; else last-used ⟷ "checked"', () => {
    const since = new Date(Date.now() - 12 * 60_000).toISOString();
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          running: true,
          runningSinceIso: since,
          checkedAtIso: '2026-06-15T06:30:00.000Z',
        })}
      />,
    );
    const when = byRegion(container, 'when') as HTMLElement;
    expect(when.textContent).toMatch(/^running 12m/);
    expect(when.querySelector('.truncate')?.getAttribute('title')).toMatch(/^Running since /);
    const checked = byComponent(when, 'proxy-checked-at') as HTMLElement;
    expect(checked.getAttribute('data-checked-at')).toBe('2026-06-15T06:30:00.000Z');
    expect(checked.textContent).toMatch(/^checked/);
    rerender(<ProfilePhoneCard {...props({ lastUsedIso: null })} />);
    expect(screen.getByText('never launched')).toBeTruthy();
    expect(byComponent(container, 'proxy-checked-at')).toBeNull();
    cleanup();
  });

  it('the meta row caps pills in JS: folder + "+N" at a narrow width, more at a wide one; the "+N" title names what was hidden', () => {
    // `visibleMeta`: dropping the `+ OVERFLOW_PILL_WIDTH` reservation lets a
    // pill that does not fit through and the count mismatch reds.
    const meta = {
      folder: 'Shopping / Netherlands',
      tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
    };
    const narrow = visibleMeta(meta, 144, 1);
    expect(narrow.pills.map((x) => x.kind)).toEqual(['folder']);
    expect(narrow.hidden).toEqual(['retail', 'nl', 'daily', 'warm', 'checkout']);
    const wide = visibleMeta(meta, 226, 0);
    expect(wide.pills.length).toBeGreaterThan(narrow.pills.length);
    expect(wide.pills.length + wide.hidden.length).toBe(6);
    const { container } = render(<ProfilePhoneCard {...props(meta)} />);
    const overflow = byComponent(
      byRegion(container, 'meta') as HTMLElement,
      'tags-overflow',
    ) as HTMLElement;
    expect(overflow).not.toBeNull();
    expect(overflow.textContent).toMatch(/^\+\d+$/);
    for (const hidden of overflow.getAttribute('title')?.split(' · ') ?? []) {
      expect(within(byRegion(container, 'meta') as HTMLElement).queryByText(hidden)).toBeNull();
    }
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Polish (2026-09-11) — the tile judged against the owner's comp and the app's
// tokens. Every arm names the class or word the render now carries; the
// Playwright quality gate (scratchpad/visual-quality.mjs) measures the contrast
// and the geometry these classes produce.
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 — the when row: compact relative forms, the left fact has priority, one case', () => {
  const NOW = Date.parse('2026-09-11T12:00:00.000Z');
  it('formatRelativeNarrow (RelativeTime’s narrow style, once the card’s compactAgo): just now · N min ago · N h ago · yesterday · N d ago · N mo ago · N yr ago; a bad or future stamp degrades', () => {
    expect(formatRelativeNarrow('2026-09-11T11:59:30.000Z', NOW)).toBe('just now');
    expect(formatRelativeNarrow('2026-09-11T11:55:00.000Z', NOW)).toBe('5 min ago');
    expect(formatRelativeNarrow('2026-09-11T10:00:00.000Z', NOW)).toBe('2 h ago');
    expect(formatRelativeNarrow('2026-09-10T12:00:00.000Z', NOW)).toBe('yesterday');
    expect(formatRelativeNarrow('2026-09-09T12:00:00.000Z', NOW)).toBe('2 d ago');
    expect(formatRelativeNarrow('2026-06-15T06:30:00.000Z', NOW)).toBe('3 mo ago');
    expect(formatRelativeNarrow('2025-08-01T00:00:00.000Z', NOW)).toBe('1 yr ago');
    expect(formatRelativeNarrow('2026-09-11T12:05:00.000Z', NOW)).toBe('just now');
    expect(formatRelativeNarrow('not a date', NOW)).toBe('—');
    // Every form is short enough to share a 144px row with a compact stamp.
    for (const s of ['59 min ago', '23 h ago', '29 d ago', '11 mo ago', '12 yr ago'])
      expect(s.length).toBeLessThanOrEqual(10);
    // The checked stamp's terse form: no 'ago' (the verb dates it), no 'yesterday'.
    expect(terseAgo('2026-09-11T11:59:30.000Z', NOW)).toBe('<1 min');
    expect(terseAgo('2026-09-11T11:01:00.000Z', NOW)).toBe('59 min');
    expect(terseAgo('2026-09-11T10:00:00.000Z', NOW)).toBe('2 h');
    expect(terseAgo('2026-09-10T12:00:00.000Z', NOW)).toBe('1 d');
    expect(terseAgo('2026-06-15T06:30:00.000Z', NOW)).toBe('3 mo');
    expect(terseAgo('2025-08-01T00:00:00.000Z', NOW)).toBe('1 yr');
    expect(terseAgo('not a date', NOW)).toBe('—');
  });

  // (p) D3 — the card's row and RelativeTime's narrow style are ONE function.
  // Rendered for the same instant, the card's "when" row and
  // `<RelativeTime style="narrow">` print the same words. Mutation: give the
  // card back a local formatter that prints '5 mins ago' (or drop the narrow
  // branch in RelativeTime so it falls to Intl's '5 minutes ago') → red.
  it('the card’s "when" row prints exactly what <RelativeTime style="narrow"> prints for the same instant, and the terse checked form is the same words without "ago"', () => {
    const now = Date.now();
    const stamp = new Date(now - 5 * 60_000).toISOString();
    const { container } = render(
      <ProfilePhoneCard {...props({ lastUsedIso: stamp, checkedAtIso: stamp })} />,
    );
    const when = byRegion(container, 'when') as HTMLElement;
    const cardWords = (when.children[0] as HTMLElement).textContent;
    const reference = render(<RelativeTime iso={stamp} nowMs={now} style="narrow" />);
    const referenceWords = reference.container.querySelector('time')?.textContent;
    expect(cardWords).toBe('5 min ago');
    expect(cardWords).toBe(referenceWords);
    expect(cardWords).toBe(formatRelativeNarrow(stamp, now));
    // The default style is untouched — the list still reads Intl's long form.
    const long = render(<RelativeTime iso={stamp} nowMs={now} />);
    expect(long.container.querySelector('time')?.textContent).toBe('5 minutes ago');
    // The checked half's terse words are the narrow style's minus 'ago'.
    const checked = byComponent(when, 'proxy-checked-at') as HTMLElement;
    expect(checked.querySelector('time')?.textContent).toBe('5 min');
    expect(`${String(checked.querySelector('time')?.textContent)} ago`).toBe(referenceWords);
    cleanup();
  });

  it('renders "3 mo ago" (never "3 months ago") and a terse "checked 3 mo"; the left is shrink-0 max-w-[60%], the checked half is min-w-0 truncate tracking-tight in ONE case with the absolute stamp as its title; the row gap is 4px', () => {
    // The when row in ProfilePhoneCard.tsx: restoring <RelativeTime> on either
    // half reds the /months/ arm; restoring `shrink-0` on the checked half (or
    // `min-w-0` on the left) reds the priority arm; putting `uppercase` back on
    // the checked half (the comp's 'CHECKED 3 MO AGO' measured 108px against
    // the 100px the 178px column leaves beside '3 mo ago') reds the case arm.
    const stamp = new Date(Date.now() - 88 * 86_400_000).toISOString();
    const { container, rerender } = render(
      <ProfilePhoneCard {...props({ lastUsedIso: stamp, checkedAtIso: stamp })} />,
    );
    const when = byRegion(container, 'when') as HTMLElement;
    expect(when.textContent).toBe('3 mo agochecked 3 mo');
    expect(when.textContent).not.toMatch(/months/);
    expect(classes(when)).toContain('gap-1');
    const left = when.children[0] as HTMLElement;
    expect(classes(left)).toEqual(expect.arrayContaining(['truncate', 'max-w-[60%]', 'shrink-0']));
    expect(classes(left)).not.toContain('min-w-0');
    expect(left.getAttribute('title')).toMatch(/^Last used: /);
    expect(left.querySelector('time')?.getAttribute('dateTime')).toBe(stamp);
    const checked = byComponent(when, 'proxy-checked-at') as HTMLElement;
    expect(classes(checked)).toEqual(
      expect.arrayContaining(['min-w-0', 'truncate', 'text-[9px]', 'tracking-tight']),
    );
    expect(classes(checked)).not.toContain('shrink-0');
    expect(classes(checked)).not.toContain('uppercase');
    expect(checked.getAttribute('title')).toMatch(/^Checked: /);
    expect(checked.querySelector('time')?.getAttribute('dateTime')).toBe(stamp);
    // With no checked stamp the left fact takes the row (min-w-0, no 60% cap).
    rerender(<ProfilePhoneCard {...props({ lastUsedIso: stamp, checkedAtIso: null })} />);
    const alone = (byRegion(container, 'when') as HTMLElement).children[0] as HTMLElement;
    expect(classes(alone)).toContain('min-w-0');
    expect(classes(alone)).not.toContain('max-w-[60%]');
    // 'never launched' carries a title that adds to the word.
    rerender(<ProfilePhoneCard {...props({ lastUsedIso: null })} />);
    expect(screen.getByText('never launched').getAttribute('title')).toBe(
      'This profile has never been launched',
    );
    cleanup();
  });

  it('a VPN failure line shows the CAUSE after the fleet preamble; a notice line shows the NEXT STEP (≤ 30 chars for the two server notices), both keep the full sentence in the title, the notice stays muted (never busy amber)', () => {
    expect(
      vpnFailureClause(
        'The test Mac could not bring the tunnel up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
      ),
    ).toBe('handshake timed out after 20 s (no reply from 193.32.127.66:51820).');
    expect(vpnFailureClause('The test Mac could not bring the tunnel up.')).toBe(
      'The test Mac could not bring the tunnel up.',
    );
    expect(vpnFailureClause('Tunnel refused by the server')).toBe('Tunnel refused by the server');
    expect(vpnNoticeClause(VPN_NOT_STORED_CHECK_NOTICE)).toBe('not stored yet — launch once');
    expect(vpnNoticeClause(VPN_NO_API_KEY_CHECK_NOTICE)).toBe('needs an API key — Settings');
    expect(vpnNoticeClause(VPN_NOT_STORED_CHECK_NOTICE).length).toBeLessThanOrEqual(30);
    expect(vpnNoticeClause(VPN_NO_API_KEY_CHECK_NOTICE).length).toBeLessThanOrEqual(30);
    expect(vpnNoticeClause('Endpoint resolves. Something else.')).toBe('Something else.');
    expect(vpnNoticeClause(VPN_NOTICE)).toBe(VPN_NOTICE);
    const failure = 'The test Mac could not bring the tunnel up: handshake timed out after 20 s.';
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: failure,
        })}
      />,
    );
    const line = byComponent(container, 'proxy-vpn-failure') as HTMLElement;
    expect(line.textContent).toBe('handshake timed out after 20 s.');
    expect(line.textContent?.startsWith('The test Mac')).toBe(false);
    expect(line.getAttribute('title')?.startsWith(failure)).toBe(true);
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOT_STORED_CHECK_NOTICE,
          endpoint: { resolved: true, message: 'Resolved' },
        })}
      />,
    );
    const notice = byComponent(container, 'proxy-vpn-notice') as HTMLElement;
    expect(notice.textContent).toBe('not stored yet — launch once');
    expect(notice.getAttribute('title')?.startsWith(VPN_NOT_STORED_CHECK_NOTICE)).toBe(true);
    expect(classes(notice)).toContain('text-ink-muted');
    expect(classes(notice)).not.toContain('text-status-busy');
    // …and beside it the pill is the grid's 'endpoint ok', not a contradiction.
    expect(pill(container).textContent).toBe('endpoint ok');
    cleanup();
  });
});

describe("P2 — frame, screen, thumbnail, status, dock: the comp's chrome on the app's tokens", () => {
  const HOVER_SHADOW =
    'hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_40px_rgba(0,0,0,0.45)]';
  const FOCUS_RING = [
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-accent-hover',
    'focus-visible:ring-offset-2',
  ];

  it('the article: a white/8% hairline over a 180° slate gradient, a hover shadow that DEEPENS, a solid focus ring; running = a mint frame; selected = accent2 border + a 2px 35% RING (survives every shadow change)', () => {
    // Article className in ProfilePhoneCard.tsx: `hover:shadow-xl` back reds the
    // hover arm (it rewrote --tw-shadow and erased the selected box-shadow ring);
    // the selected ring back into `shadow-[0_0_0_1.5px…]` reds the ring arm.
    const { container, rerender } = render(<ProfilePhoneCard {...props()} />);
    const article = (): HTMLElement => container.querySelector('article') as HTMLElement;
    expect(classes(article())).toEqual(
      expect.arrayContaining([
        'border-white/[0.08]',
        HOVER_SHADOW,
        'hover:-translate-y-0.5',
        ...FOCUS_RING,
        'focus-visible:ring-offset-surface-base',
      ]),
    );
    expect(classes(article())).not.toContain('hover:shadow-xl');
    expect(classes(article())).not.toContain('border-[#0a0d12]');
    expect(classes(article())).not.toContain('transition-all');
    expect(article().getAttribute('style')).toContain('180deg');
    rerender(<ProfilePhoneCard {...props({ running: true })} />);
    expect(classes(article())).toContain('border-status-ready/35');
    rerender(<ProfilePhoneCard {...props({ selected: true })} />);
    expect(classes(article())).toEqual(
      expect.arrayContaining([
        'border-accent-hover',
        'ring-2',
        'ring-accent-hover/35',
        HOVER_SHADOW,
      ]),
    );
    expect(classes(article()).some((c) => c.startsWith('shadow-[0_0_0_1.5px'))).toBe(false);
    cleanup();
  });

  it('the screen carries ONE radial hue wash (no full-screen tint, no blurred disc, no inset vignette) plus the gloss; the select indicator is a hollow white/35 ring at z-[15], BELOW the menu (z-20)', () => {
    const { container } = render(<ProfilePhoneCard {...props({ hue: 150 })} />);
    const screenEl = byComponent(container, 'phone-screen') as HTMLElement;
    const washes = screenEl.querySelectorAll('[data-component="screen-wash"]');
    expect(washes).toHaveLength(1);
    expect(washes[0]?.getAttribute('style')).toMatch(/radial-gradient\(120% 55% at 50% -10%/);
    expect(washes[0]?.getAttribute('style')).toContain('hsl(150 60% 55% / 0.28)');
    expect(screenEl.querySelector('.blur-2xl')).toBeNull();
    expect(screenEl.querySelector('.opacity-\\[0\\.16\\]')).toBeNull();
    expect(
      Array.from(screenEl.querySelectorAll('*')).some((el) =>
        classes(el).some((c) => c.startsWith('shadow-[inset_0_0_28px')),
      ),
    ).toBe(false);
    const indicator = byComponent(container, 'select-indicator') as HTMLElement;
    expect(classes(indicator)).toEqual(
      expect.arrayContaining(['z-[15]', 'border-white/35', 'bg-transparent']),
    );
    expect(classes(indicator)).not.toContain('bg-black/35');
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    const z = (el: HTMLElement): number =>
      Number(
        classes(el)
          .find((c) => /^z-/.test(c))
          ?.replace(/^z-\[?(\d+)\]?$/, '$1'),
      );
    expect(z(indicator)).toBeLessThan(z(menu));
    cleanup();
  });

  it('the thumbnail is TWO recipes keyed by hue — light gradient (L58→L52) + inverted ink on 4–175, dark gradient (L32→L24) + white on 176–3 — with the worst-case stop as its background-color; the device line and the Idle word are ink-secondary; the health pill is flush right; exactly ONE dot pulses on a live tile', () => {
    // `thumbUsesDarkInk` + the identity-thumb style in ProfilePhoneCard.tsx:
    // one gradient for every hue reds this (the orange and cyan troughs fail
    // 4.5 with BOTH inks — computed over the hue wheel at both stops).
    expect([4, 28, 60, 120, 150, 175].every(thumbUsesDarkInk)).toBe(true);
    expect([0, 3, 176, 190, 210, 260, 300, 341, 359].some(thumbUsesDarkInk)).toBe(false);
    expect(thumbUsesDarkInk(-300)).toBe(true);
    expect(thumbUsesDarkInk(570)).toBe(false);
    const { container, rerender } = render(<ProfilePhoneCard {...props({ hue: 150 })} />);
    const thumb = (): HTMLElement => byComponent(container, 'identity-thumb') as HTMLElement;
    expect(classes(thumb())).toContain('text-ink-inverted');
    expect(thumb().getAttribute('data-ink')).toBe('dark');
    expect(thumb().getAttribute('style')).toContain('hsl(150 58% 58%)');
    expect(thumb().getAttribute('style')).toContain('hsl(184 52% 52%)');
    // jsdom serialises a colour as rgb(); compare through its own conversion.
    const rgb = (hsl: string): string => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = hsl;
      return probe.style.backgroundColor;
    };
    expect(thumb().style.backgroundColor).toBe(rgb('hsl(184 52% 52%)'));
    rerender(<ProfilePhoneCard {...props({ hue: 210 })} />);
    expect(classes(thumb())).toContain('text-white');
    expect(thumb().getAttribute('data-ink')).toBe('white');
    expect(thumb().getAttribute('style')).toContain('hsl(210 58% 32%)');
    expect(thumb().getAttribute('style')).toContain('hsl(244 52% 24%)');
    expect(thumb().style.backgroundColor).toBe(rgb('hsl(210 58% 32%)'));
    rerender(<ProfilePhoneCard {...props({ hue: 175 })} />);
    expect(classes(thumb())).toContain('text-ink-inverted');
    rerender(<ProfilePhoneCard {...props({ hue: 176 })} />);
    expect(classes(thumb())).toContain('text-white');
    expect(classes(screen.getByText('iPhone 17'))).toContain('text-ink-secondary');
    expect(classes(screen.getByText('Idle'))).toContain('text-ink-secondary');
    expect(classes(pill(container))).toContain('ml-auto');
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    rerender(<ProfilePhoneCard {...props({ running: true })} />);
    const pulsing = container.querySelectorAll('.animate-pulse');
    expect(pulsing).toHaveLength(1);
    expect(pulsing[0]?.getAttribute('data-component')).toBe('thumb-live-dot');
    expect(classes(pulsing[0] as HTMLElement)).toEqual(
      expect.arrayContaining([
        'h-1.5',
        'w-1.5',
        'ring-2',
        'ring-surface-raised',
        '[animation-duration:1.6s]',
      ]),
    );
    cleanup();
  });

  it('the dock: a white/6% hairline; Launch is a 30px 12px block titled with a sentence; live → mint tint, launching → the neutral busy button at FULL opacity (only launchDisabled dims); ⋯ is a borderless white/6% fill; both wear the solid focus ring', () => {
    const { container, rerender } = render(<ProfilePhoneCard {...props()} />);
    const dock = byComponent(container, 'card-dock') as HTMLElement;
    expect(classes(dock)).toContain('border-white/[0.06]');
    expect(classes(dock)).not.toContain('border-surface-divider');
    const launch = (): HTMLElement =>
      screen.getByRole('button', { name: /^(Launch|Open session|Launching…)$/ });
    expect(classes(launch())).toEqual(
      expect.arrayContaining([
        'h-[30px]',
        'text-[12px]',
        'leading-[30px]',
        'bg-accent',
        'enabled:hover:bg-accent-hover',
        'disabled:opacity-50',
        ...FOCUS_RING,
      ]),
    );
    expect(classes(launch())).not.toContain('py-1.5');
    expect(classes(launch())).not.toContain('hover:bg-accent-hover');
    expect(launch().getAttribute('title')).toBe('Launch a session with this profile');
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(classes(more)).toEqual(
      expect.arrayContaining(['bg-white/[0.06]', 'text-ink-primary', ...FOCUS_RING]),
    );
    expect(classes(more)).not.toContain('border');
    expect(classes(more)).not.toContain('border-surface-divider');
    rerender(<ProfilePhoneCard {...props({ running: true })} />);
    expect(classes(launch())).toEqual(
      expect.arrayContaining(['bg-status-ready/[0.18]', 'text-status-ready']),
    );
    expect(classes(launch())).not.toContain('border');
    expect(launch().getAttribute('title')).toBe('Open the running session');
    rerender(<ProfilePhoneCard {...props({ busy: true, launching: true })} />);
    expect(classes(launch())).toEqual(
      expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary', 'cursor-progress']),
    );
    expect(classes(launch())).not.toContain('disabled:opacity-50');
    expect(classes(launch())).not.toContain('bg-accent');
    expect(launch().getAttribute('title')).toBe(
      'Launching — the proxy is checked before the session starts',
    );
    const spinner = byComponent(container, 'launch-spinner') as HTMLElement;
    expect(classes(spinner)).toEqual(
      expect.arrayContaining(['border-ink-muted/40', 'border-t-ink-secondary']),
    );
    expect(classes(spinner)).not.toContain('border-white/35');
    rerender(
      <ProfilePhoneCard
        {...props({ launchDisabled: true, launchDisabledReason: 'Sign in first' })}
      />,
    );
    expect(classes(launch())).toContain('disabled:opacity-50');
    expect(launch().getAttribute('title')).toBe('Sign in first');
    cleanup();
  });
});

describe('P3 — via, caps, meta rows: pills and chips in one family', () => {
  it('the VPN tag keeps the oxblood tint with the LIGHT rose ink and a title that says what VPN means (Check VPN stays on the button + menu row); via is tracking-wider; the address is 9.5px mono; the default badge is a lowercase hairline box', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const tag = byComponent(container, 'proxy-vpn-tag') as HTMLElement;
    expect(tag.textContent).toBe('VPN');
    expect(classes(tag)).toEqual(
      expect.arrayContaining(['bg-accent-subtle', 'text-[#e8a0ab]', 'tracking-wide', 'uppercase']),
    );
    expect(classes(tag)).not.toContain('text-accent');
    expect(tag.getAttribute('title')).toBe(
      'OpenVPN / WireGuard tunnel — the whole session, UDP included, travels inside it',
    );
    expect(tag.getAttribute('title')).not.toBe(CHECK_VPN_TITLE);
    expect(screen.getByRole('button', { name: CHECK_VPN_ACTION }).getAttribute('title')).toBe(
      CHECK_VPN_TITLE,
    );
    rerender(
      <ProfilePhoneCard
        {...props({ proxyName: null, proxyAddress: '10.0.0.5:1080', proxyExplicit: false })}
      />,
    );
    expect(classes(screen.getByText('via'))).toContain('tracking-wider');
    expect(classes(screen.getByText('10.0.0.5:1080'))).toEqual(
      expect.arrayContaining(['mono', 'text-[9.5px]']),
    );
    const badge = byComponent(container, 'proxy-inherited-badge') as HTMLElement;
    expect(badge.textContent).toBe('default');
    expect(classes(badge)).toEqual(
      expect.arrayContaining([
        'border',
        'border-surface-divider',
        'text-ink-secondary',
        'leading-[14px]',
      ]),
    );
    expect(classes(badge)).not.toContain('uppercase');
    expect(classes(badge)).not.toContain('bg-surface-divider/40');
    cleanup();
  });

  it('chips are 9.5px/600 radius-6 with ONE muted family; the OS chip wears the same chrome (data-component + data-os-tone kept); the "+N" tails on the caps AND meta rows are dashed and transparent', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          osFingerprint: REAL_OS,
          folder: 'Shopping / Netherlands',
          tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
        })}
      />,
    );
    const udp = container.querySelector('[data-udp="true"]') as HTMLElement;
    expect(classes(udp)).toEqual(
      expect.arrayContaining([
        'text-[9.5px]',
        'font-semibold',
        'rounded-md',
        'bg-status-ready/10',
        'text-status-ready',
      ]),
    );
    expect(classes(udp)).not.toContain('text-[9px]');
    expect(classes(udp)).not.toContain('font-bold');
    const os = byComponent(
      byRegion(container, 'caps') as HTMLElement,
      'proxy-os-fingerprint',
    ) as HTMLElement;
    expect(os.getAttribute('data-os-tone')).toBe('match');
    expect(os.textContent).toBe('✓ iOS/macOS');
    expect(classes(os)).toEqual(
      expect.arrayContaining(['text-[9.5px]', 'font-semibold', 'rounded-md', 'text-status-ready']),
    );
    expect(classes(os)).not.toContain('rounded-sm');
    const tail = byComponent(container, 'tags-overflow') as HTMLElement;
    expect(classes(tail)).toEqual(
      expect.arrayContaining(['border-dashed', 'bg-transparent', 'text-ink-muted']),
    );
    expect(classes(screen.getByText('📁 Shopping / Netherlands'))).toEqual(
      expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']),
    );
    expect(classes(screen.getByText('📁 Shopping / Netherlands'))).not.toContain('border');
    expect(classes(screen.getByText('📁 Shopping / Netherlands'))).not.toContain(
      'bg-surface-inset',
    );
    // The meta row carries no row-level title; the sealed-store size lives in
    // the details sheet (Phase C — it was a static info row in the ⋯ menu),
    // never on the resting tile and never for '—' (a profile never saved).
    expect(byRegion(container, 'meta')?.getAttribute('title')).toBeNull();
    cleanup();
    const { container: sized } = render(<ProfilePhoneCard {...props({ sizeLabel: '128 MB' })} />);
    expect(byRegion(sized, 'meta')?.getAttribute('title')).toBeNull();
    expect(document.querySelector('[title*="Stored profile size"]')).toBeNull();
    expect((byComponent(sized, 'card-body') as HTMLElement).textContent).not.toContain('128 MB');
    expect(byComponent(document, 'card-actions-menu')?.textContent).not.toContain('128 MB');
    fireEvent.click(screen.getByLabelText('Details for amsterdam shopper'));
    const sizeRow = sized.querySelector('[title*="Stored profile size"]') as HTMLElement;
    expect(byComponent(sized, 'card-details-sheet')?.contains(sizeRow)).toBe(true);
    expect(sizeRow.getAttribute('data-component')).toBe('profile-size');
    cleanup();
    const { container: unsaved } = render(<ProfilePhoneCard {...props({ sizeLabel: '—' })} />);
    fireEvent.click(screen.getByLabelText('Details for amsterdam shopper'));
    expect(byComponent(unsaved, 'card-details-sheet')).not.toBeNull();
    expect(byComponent(unsaved, 'profile-size')).toBeNull();
    cleanup();
    const { container: first } = render(
      <ProfilePhoneCard
        {...props({ probed: false, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    expect(classes(byComponent(first, 'caps-overflow') as HTMLElement)).toEqual(
      expect.arrayContaining(['border-dashed', 'bg-transparent', 'text-[9.5px]']),
    );
    cleanup();
  });

  it("the repair row: Re-test (the Proxies tab's word) is OUTLINED red-300, Change / Test are outlined divider buttons, all 10px/600 with transition-colors, enabled-guarded hovers and an inset focus ring; in flight the button is the neutral busy button at full opacity with aria-busy", () => {
    expect(RETEST_ACTION).toBe('Re-test');
    // (p) D1 — the grid renders the constant, not a literal of its own.
    expect(source('views/ProxiesView.tsx')).toContain('? RETEST_ACTION :');
    expect(source('views/ProxiesView.tsx')).not.toContain("'Re-test'");
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: CANNOT_ROUTE, onEdit: vi.fn() })}
      />,
    );
    const retest = screen.getByRole('button', { name: RETEST_ACTION });
    expect(screen.queryByRole('button', { name: 'Retest' })).toBeNull();
    expect(classes(retest)).toEqual(
      expect.arrayContaining([
        'border',
        'border-status-error/45',
        'bg-status-error/10',
        'text-[#fca5a5]',
        'text-[10px]',
        'font-semibold',
        'transition-colors',
        'enabled:hover:bg-status-error/20',
        'focus-visible:ring-inset',
        'disabled:opacity-50',
      ]),
    );
    expect(classes(retest)).not.toContain('text-status-error');
    expect(classes(retest)).not.toContain('text-[9.5px]');
    expect(retest.getAttribute('aria-busy')).toBe('false');
    const change = screen.getByRole('button', { name: 'Change' });
    expect(classes(change)).toEqual(
      expect.arrayContaining([
        'border',
        'border-surface-divider',
        'text-[10px]',
        'transition-colors',
        'enabled:hover:bg-surface-divider',
        'focus-visible:ring-inset',
      ]),
    );
    expect(classes(change)).not.toContain('hover:bg-surface-divider');
    rerender(
      <ProfilePhoneCard
        {...props({
          exitIp: null,
          latencyMs: null,
          capabilities: CANNOT_ROUTE,
          onEdit: vi.fn(),
          testing: true,
        })}
      />,
    );
    const busy = screen.getByRole('button', { name: 'Testing…' });
    expect(busy).toBeDisabled();
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(classes(busy)).toEqual(
      expect.arrayContaining(['cursor-progress', 'bg-surface-elevated', 'text-ink-secondary']),
    );
    expect(classes(busy)).not.toContain('disabled:opacity-50');
    rerender(
      <ProfilePhoneCard
        {...props({ probed: false, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const test = screen.getByRole('button', { name: 'Test' });
    expect(classes(test)).toEqual(
      expect.arrayContaining([
        'border',
        'border-surface-divider',
        'text-[10px]',
        'font-semibold',
        'transition-colors',
        'enabled:hover:bg-surface-divider',
        'focus-visible:ring-inset',
        'disabled:opacity-50',
      ]),
    );
    rerender(
      <ProfilePhoneCard
        {...props({
          probed: false,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          testing: true,
        })}
      />,
    );
    const testBusy = screen.getByRole('button', { name: 'Test' });
    expect(testBusy).toBeDisabled();
    expect(testBusy.getAttribute('aria-busy')).toBe('true');
    expect(classes(testBusy)).toContain('cursor-progress');
    expect(classes(testBusy)).not.toContain('disabled:opacity-50');
    // The note glyph is a 16px box with the inset ring.
    rerender(<ProfilePhoneCard {...props({ note: 'vip', onSaveNote: vi.fn() })} />);
    expect(classes(byComponent(container, 'profile-note') as HTMLElement)).toEqual(
      expect.arrayContaining([
        'grid',
        'h-4',
        'w-4',
        'focus-visible:ring-inset',
        'transition-colors',
      ]),
    );
    cleanup();
  });

  it('vertical rhythm: body pt-1.5 pb-1, gaps 5/4/2/4/4/2 (identity · status · exit · via · caps · when) — 10 + 142 + 21 = 173', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    expect(classes(byComponent(container, 'card-body'))).toEqual(
      expect.arrayContaining(['pt-1.5', 'pb-1']),
    );
    expect(classes(byComponent(container, 'card-body'))).not.toContain('pb-1.5');
    const gap = (name: string): string | undefined =>
      classes(byRegion(container, name)).find((c) => /^mb-/.test(c));
    expect([
      gap('identity'),
      gap('status'),
      gap('exit'),
      gap('via'),
      gap('caps'),
      gap('when'),
      gap('meta'),
    ]).toEqual(['mb-[5px]', 'mb-1', 'mb-[2px]', 'mb-1', 'mb-1', 'mb-[2px]', undefined]);
    cleanup();
  });
});

describe('P4 — the ⋯ group: labelled, arrow keys, focus restored to ⋯, Launch closes it', () => {
  const full = (): Partial<ProfilePhoneCardProps> => ({
    onEdit: vi.fn(),
    onClone: vi.fn(),
    onActivity: vi.fn(),
    onTrim: vi.fn(),
    onDelete: vi.fn(),
  });

  it('a labelled role=group of plain buttons (a role=menu of role-less buttons announced as an empty menu; menuitems would break every getByRole("button") pin); ⋯ carries aria-controls; the Clear rows sit in a nested group; rows wear an inset focus ring; the stored size is NOT a menu row (Phase C: the sheet)', () => {
    const { container } = render(
      <ProfilePhoneCard {...props({ ...full(), sizeLabel: '3.0 MiB' })} />,
    );
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    expect(menu.getAttribute('role')).toBe('group');
    expect(menu.getAttribute('aria-label')).toBe('More actions for amsterdam shopper');
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.id.length).toBeGreaterThan(0);
    for (const b of menu.querySelectorAll('button')) {
      expect(b.getAttribute('role'), b.getAttribute('aria-label') ?? '').toBeNull();
      expect(classes(b)).toContain('focus-visible:outline-offset-[-2px]');
    }
    // Phase C: the size is no menu row any more (the details sheet holds it —
    // see a-card-details-sheet-holds-every-fact-the-tile-cut.test.tsx).
    expect(byComponent(menu, 'profile-size')).toBeNull();
    expect(menu.textContent).not.toContain('3.0 MiB');
    expect(byRegion(container, 'meta')?.getAttribute('title')).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByLabelText(/^Clearing options for /));
    expect(screen.getByLabelText(/^Clear cache for /).parentElement?.getAttribute('role')).toBe(
      'group',
    );
    cleanup();
  });

  it('ArrowDown on ⋯ opens the menu and focuses its first enabled item; ArrowDown/ArrowUp/Home/End walk the enabled items (a disabled row is skipped); Escape closes it and returns focus to ⋯', () => {
    render(<ProfilePhoneCard {...props({ ...full(), running: true, onStop: vi.fn() })} />);
    const more = screen.getByRole('button', { name: 'More actions' });
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    expect(menu.getAttribute('data-open')).toBe('true');
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => !b.disabled,
    );
    expect(items.length).toBeGreaterThan(3);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    // Delete is disabled while running: End landed on the last ENABLED row.
    expect(screen.getByLabelText<HTMLButtonElement>('Delete amsterdam shopper').disabled).toBe(
      true,
    );
    expect(document.activeElement).not.toBe(screen.getByLabelText('Delete amsterdam shopper'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(more);
    cleanup();
  });

  it("activating a row (Enter → click) closes the menu and returns focus to ⋯; the row's handler fires once", () => {
    const onEdit = vi.fn();
    render(<ProfilePhoneCard {...props({ ...full(), onEdit })} />);
    const more = screen.getByRole('button', { name: 'More actions' });
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const edit = screen.getByLabelText('Edit amsterdam shopper');
    edit.focus();
    expect(document.activeElement).toBe(edit);
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(menu.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(more);
    // Mounting a closed card never steals focus (the restore effect is gated on a prior open).
    cleanup();
    render(<ProfilePhoneCard {...props(full())} />);
    expect(document.activeElement).toBe(document.body);
    cleanup();
  });

  it('with the menu open, clicking Launch launches AND closes the menu; a pointer-down on the dock outside ⋯ closes it too', () => {
    const onPrimary = vi.fn();
    const { container } = render(<ProfilePhoneCard {...props({ ...full(), onPrimary })} />);
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(menu.getAttribute('data-open')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(menu.getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(menu.getAttribute('data-open')).toBe('true');
    fireEvent.pointerDown(byComponent(container, 'card-dock') as HTMLElement);
    expect(menu.getAttribute('data-open')).toBe('false');
    // …but a pointer-down on ⋯ itself is "inside" (the toggle, not the closer).
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }));
    expect(menu.getAttribute('data-open')).toBe('true');
    cleanup();
  });
});

describe('CONTROL — every gallery state', () => {
  it('has the Launch control present, unhidden and OUTSIDE the body; every truncate/line-clamp element titled; all seven regions in order; the health pill exactly once', () => {
    // Renders the harness's own STATES (imported, not copied) so a state added
    // for the gate is a state this arm covers.
    expect(STATES.length).toBeGreaterThanOrEqual(20);
    for (const state of STATES) {
      const { container, unmount } = render(<ProfilePhoneCard {...state.props} />);
      const article = container.querySelector('article') as HTMLElement;
      const body = byComponent(container, 'card-body') as HTMLElement;
      expect(body, `${state.label}: card-body missing`).not.toBeNull();
      const launch = screen.getByRole('button', { name: /^(Launch|Open session|Launching…)$/ });
      expect(launch.hidden, `${state.label}: Launch hidden`).toBe(false);
      expect(classes(launch), `${state.label}: Launch hidden by class`).not.toContain('hidden');
      expect(
        launch.closest('[aria-hidden="true"]'),
        `${state.label}: Launch aria-hidden`,
      ).toBeNull();
      expect(article.contains(launch), `${state.label}: Launch outside the card`).toBe(true);
      expect(body.contains(launch), `${state.label}: Launch inside the body`).toBe(false);
      expect(
        Array.from(container.querySelectorAll('[data-region]')).map((r) =>
          r.getAttribute('data-region'),
        ),
        `${state.label}: regions`,
      ).toEqual(['identity', 'status', 'exit', 'via', 'caps', 'when', 'meta']);
      expect(
        container.querySelectorAll('[data-component="health-pill"]'),
        `${state.label}: pill`,
      ).toHaveLength(1);
      expect(container.textContent, `${state.label}: no stale / Starting…`).not.toMatch(
        /\bstale\b|Starting…/,
      );

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
