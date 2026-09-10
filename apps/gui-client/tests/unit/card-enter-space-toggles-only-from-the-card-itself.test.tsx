// MED #4 — the phone card is a role="button" that toggles selection on
// Enter/Space. Its onKeyDown was unguarded, so a keydown bubbling up from a
// nested control (Launch, the ⋯ menu, the Retest/Change buttons) reached the
// card handler and flipped selection AND pre-empted that control's own keyboard
// activation. The fix returns early unless the event originated on the article
// itself (`e.target !== e.currentTarget`).
//
// This guard must turn red if that early-return is reverted: firing an Enter
// keydown on the nested Launch button would then call onToggleSelect.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';

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

describe('ProfilePhoneCard — Enter/Space toggles selection only from the card itself (MED #4)', () => {
  it('a keydown from a nested control does NOT toggle selection, but the card itself does', () => {
    const onToggleSelect = vi.fn();
    render(<ProfilePhoneCard {...cardProps({ onToggleSelect })} />);

    // The Launch button lives inside the card. Enter/Space keydown on it bubbles
    // to the card's onKeyDown, which must decline because the event did not
    // originate on the article. Reverting the `e.target !== e.currentTarget`
    // guard makes both of these fire the toggle — this is the assertion that
    // breaks on a revert.
    const launch = screen.getByRole('button', { name: 'Launch' });
    fireEvent.keyDown(launch, { key: 'Enter' });
    fireEvent.keyDown(launch, { key: ' ' });
    expect(onToggleSelect).not.toHaveBeenCalled();

    // Second nested control: the ⋯ "More actions" toggle. Same expectation.
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    expect(onToggleSelect).not.toHaveBeenCalled();

    // Positive control (vacuity guard): a keydown ORIGINATING on the article
    // still toggles, so "not called" above is a live handler declining a nested
    // target, not a handler that never runs.
    const card = screen.getByRole('button', { name: 'Select amsterdam shopper' });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: ' ' });
    expect(onToggleSelect).toHaveBeenCalledTimes(2);
  });
});
