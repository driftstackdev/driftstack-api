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

  it('renders folder + tag pills', () => {
    render(<ProfilePhoneCard {...props({ folder: 'Shopping', tags: ['aged'] })} />);
    expect(screen.getByText('📁 Shopping')).toBeTruthy();
    expect(screen.getByText('aged')).toBeTruthy();
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
