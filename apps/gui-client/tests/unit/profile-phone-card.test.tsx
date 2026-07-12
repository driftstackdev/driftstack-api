// GX ProfilePhoneCard — the phone-framed grid card. Asserts the core data shows
// (name, device, exit IP / untested prompt), status (Live/Idle), folder/tag
// pills, and that the dock actions + selection fire their handlers.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';

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
    const trim = screen.getByLabelText(/^Trim /);
    const dup = screen.getByLabelText(/^Duplicate /);
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect((trim as HTMLButtonElement).disabled).toBe(true);
    expect((dup as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute('title')).toMatch(/Another profile is busy/i);
    cleanup();
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
