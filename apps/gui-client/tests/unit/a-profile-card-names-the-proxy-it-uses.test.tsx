// "Profile should display which kind of proxy label it's using as well."
// (owner item N-6.)
//
// The card only ever received `hasProxy`, a boolean. The resolved ProxyConfig —
// which carries `label` — was in scope at the ProfilesView call site and dropped
// there, so the component had no name to render. A customer with several saved
// proxies could see THAT a profile had one and never WHICH, which is exactly the
// case where it matters: two otherwise-identical cards.
//
// Reuses the existing card's props factory rather than a hand-rolled fixture —
// this component takes ~25 required props and an incomplete literal fails to
// mount for reasons that have nothing to do with the proxy name.

// GX ProfilePhoneCard — the phone-framed grid card. Asserts the core data shows
// (name, device, exit IP / untested prompt), status (Live/Idle), folder/tag
// pills, and that the dock actions + selection fire their handlers.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

const nameRow = (): HTMLElement | null =>
  document.querySelector('[data-component="profile-card-proxy-name"]');

afterEach(() => cleanup());

describe('the card names the proxy it is using (N-6)', () => {
  it('renders the proxy label', () => {
    render(<ProfilePhoneCard {...props({ proxyName: 'TMobile-VA' })} />);
    expect(nameRow()).not.toBeNull();
    expect(screen.getByText('TMobile-VA')).toBeTruthy();
  });

  it('distinguishes two profiles whose country and exit IP match', () => {
    // The owner's actual case. Without the name these cards are identical.
    const { container: a } = render(<ProfilePhoneCard {...props({ proxyName: 'TMobile-VA' })} />);
    const { container: b } = render(
      <ProfilePhoneCard {...props({ proxyName: 'Verizon-CA-Torrance' })} />,
    );
    expect(a.textContent).toContain('TMobile-VA');
    expect(b.textContent).toContain('Verizon-CA-Torrance');
    expect(a.textContent).not.toBe(b.textContent);
  });

  it('renders no name row when the proxy has no label', () => {
    // An empty row would read as a nameless proxy rather than an unnamed one.
    render(<ProfilePhoneCard {...props({ proxyName: null })} />);
    expect(nameRow()).toBeNull();
  });

  it('renders no name row for a profile with no proxy at all', () => {
    // Vacuity control: the arms above pass because a name was supplied, not
    // because the row is unconditional.
    render(<ProfilePhoneCard {...props({ hasProxy: false, proxyName: null })} />);
    expect(nameRow()).toBeNull();
  });
});
