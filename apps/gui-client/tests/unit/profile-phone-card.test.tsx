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
    organizeOpen: false,
    organizeSlot: <div data-testid="org-slot" />,
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onOrganizeToggle: vi.fn(),
    onTest: vi.fn(),
    ...over,
  };
}

describe('ProfilePhoneCard', () => {
  it('shows identity + device + real exit IP + capability chips; Launch fires onPrimary', () => {
    const onPrimary = vi.fn();
    render(<ProfilePhoneCard {...props({ onPrimary })} />);
    expect(screen.getByText('amsterdam shopper')).toBeTruthy();
    expect(screen.getByText('AS')).toBeTruthy();
    expect(screen.getByText('iPhone 17')).toBeTruthy();
    expect(screen.getByText('82.14.220.9')).toBeTruthy();
    expect(screen.getByText('WebRTC')).toBeTruthy(); // capability chip
    expect(screen.getByText('Idle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('running → Live status + an "Open" primary action', () => {
    render(<ProfilePhoneCard {...props({ running: true })} />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    cleanup();
  });

  it('no exit IP → "run Test for exit IP"; no proxy → "no proxy bound"', () => {
    render(<ProfilePhoneCard {...props({ exitIp: null })} />);
    expect(screen.getByText('run Test for exit IP')).toBeTruthy();
    cleanup();
    render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    expect(screen.getByText('no proxy bound')).toBeTruthy();
    cleanup();
  });

  it('renders folder + tag pills', () => {
    render(<ProfilePhoneCard {...props({ folder: 'Shopping', tags: ['aged'] })} />);
    expect(screen.getByText('📁 Shopping')).toBeTruthy();
    expect(screen.getByText('aged')).toBeTruthy();
    cleanup();
  });

  it('selection + test fire their handlers; organizeSlot shows when open', () => {
    const onToggleSelect = vi.fn();
    const onTest = vi.fn();
    render(<ProfilePhoneCard {...props({ onToggleSelect, onTest, organizeOpen: true })} />);
    fireEvent.click(screen.getByLabelText(/Select amsterdam shopper/));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle(/Test proxy/));
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('org-slot')).toBeTruthy();
    cleanup();
  });
});
