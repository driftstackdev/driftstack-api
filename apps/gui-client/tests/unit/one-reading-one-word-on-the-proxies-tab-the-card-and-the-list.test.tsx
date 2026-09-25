// Owner item 9 (2026-09-24), second round — "they should all always show accurate
// stats": the differences the first round left, closed.
//
//   1. The Proxies tab's header said "N WebRTC + QUIC" and counted the native UDP
//      grant alone, so a proxy whose QUIC chip read ⤵ or ~ was counted as carrying
//      QUIC. It is "UDP + QUIC" now and counts the rows whose OWN chips read ✓ UDP
//      and ✓ QUIC (`rowShowsUdpAndQuic`).
//   2. One word for the UDP reading: the Proxies tab's chip said "WebRTC", the card
//      and the list said "UDP". It is "UDP" everywhere, WebRTC in the hover.
//   3. A VPN row on a plan without VPN: the Proxies tab said "not included on this
//      plan", the card said "⇢ UDP" (not measured YET) about the same tunnel. The
//      card and the list now say what the grid says: "UDP — not on plan".
//   4. The list kept QUIC in a tooltip and showed nothing for an OS nobody had
//      measured. Its Network cell now draws the card's own QUIC chip and states
//      "— QUIC" / "— OS" where nothing was measured.

import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProxyTestResult } from '../../src/lib/proxies';
import { ProxyCapabilityChips, UDP_LABEL } from '../../src/components/ProxyCapabilities';
import {
  ProfilePhoneCard,
  capabilityChips,
  capsMode,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableProps,
} from '../../src/components/ProfilesTable';
import { rowShowsUdpAndQuic } from '../../src/views/ProxiesView';
import {
  NOT_ON_THIS_PLAN_LABEL,
  UDP_NOT_ON_PLAN_CHIP,
  VPN_UDP_NOT_ON_PLAN_HINT,
} from '../../src/lib/proxy-check-copy';

const OK_UDP: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 40,
  message: 'ok',
};
const NO_UDP: ProxyTestResult = { ...OK_UDP, udp_associate: false };
const DOWN: ProxyTestResult = { ...OK_UDP, reachable: false, auth_ok: false, can_route: false };
const SOCKS = { scheme: 'socks5' as const };
const WG = { scheme: 'wireguard' as const };

describe('1 — "UDP + QUIC" counts the rows whose chips read ✓ UDP AND ✓ QUIC', () => {
  it('CRITICAL a UDP grant with an INFERRED or MEASURED-negative QUIC is not counted (it was)', () => {
    // Nothing measured QUIC: the chip reads "~ QUIC" — a guess, not a tick.
    expect(rowShowsUdpAndQuic(SOCKS, OK_UDP, undefined, undefined, undefined)).toBe(false);
    // A live session measured HTTP/2 only: "⤵ QUIC".
    expect(rowShowsUdpAndQuic(SOCKS, OK_UDP, undefined, 'h2-only', undefined)).toBe(false);
    // …and a live h2-only outranks an older relay tick, as the chip does.
    expect(rowShowsUdpAndQuic(SOCKS, OK_UDP, undefined, 'h2-only', true)).toBe(false);
  });

  it('counts ✓ UDP with a measured ✓ QUIC, from a live session or the relay check', () => {
    expect(rowShowsUdpAndQuic(SOCKS, OK_UDP, undefined, 'h3', undefined)).toBe(true);
    expect(rowShowsUdpAndQuic(SOCKS, OK_UDP, undefined, undefined, true)).toBe(true);
  });

  it('a row whose UDP is not ✓ is not counted, whatever its QUIC says', () => {
    expect(rowShowsUdpAndQuic(SOCKS, NO_UDP, undefined, 'h3', true)).toBe(false);
    expect(rowShowsUdpAndQuic(SOCKS, DOWN, true, 'h3', true)).toBe(false);
  });

  it('a VPN row, and a proxy only Driftstack measured, count on MEASURED UDP only — never "a tunnel carries UDP"', () => {
    expect(rowShowsUdpAndQuic(WG, undefined, undefined, 'h3', undefined)).toBe(false);
    expect(rowShowsUdpAndQuic(WG, undefined, true, 'h3', undefined)).toBe(true);
    expect(rowShowsUdpAndQuic(SOCKS, undefined, true, undefined, true)).toBe(true);
    expect(rowShowsUdpAndQuic(SOCKS, undefined, false, undefined, true)).toBe(false);
  });
});

describe('2 — one word for the UDP reading', () => {
  it('CRITICAL the Proxies tab’s chip reads "UDP" (it read "WebRTC"), and WebRTC is in its hover', () => {
    expect(UDP_LABEL).toBe('UDP');
    const { container } = render(<ProxyCapabilityChips result={OK_UDP} />);
    const chip = container.querySelector('[data-capability="webrtc"]') as HTMLElement;
    expect(chip.textContent).toBe('✓UDP');
    expect(chip.getAttribute('title')).toMatch(/WebRTC/);
    expect(container.textContent).not.toContain('WebRTC');
    cleanup();
  });
});

function cardProps(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: 'zurich banking',
    monogram: 'ZB',
    hue: 200,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: null,
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    flag: '🇨🇭',
    countryCode: 'CH',
    exitIp: null,
    latencyMs: null,
    latencyFillPct: 0,
    latencyGood: false,
    probed: false,
    capabilities: null,
    checkedAtIso: null,
    busy: false,
    launching: false,
    anyBusy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    vpn: true,
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onTest: vi.fn(),
    ...over,
  };
}

describe('3 — a VPN row on a plan without VPN says so on the card, as the Proxies tab does', () => {
  it('CRITICAL the card’s UDP chip reads "— UDP · not on plan" (it read "⇢ UDP"), whole, beside "— OS", with no "+N"', () => {
    const p = cardProps({ planExcludesVpn: true });
    expect(capsMode(p)).toBe('measured');
    const { container } = render(<ProfilePhoneCard {...p} />);
    const caps = container.querySelector('[data-region="caps"]') as HTMLElement;
    const udp = caps.querySelector('[data-udp]') as HTMLElement;
    expect(udp.textContent).toBe(UDP_NOT_ON_PLAN_CHIP);
    // gui-v0.1.72 — the one vocabulary: the missing state, mark first, the plan
    // as its detail (it read "UDP — not on plan", the word before the mark).
    expect(udp.textContent).toBe(`— UDP · ${NOT_ON_THIS_PLAN_LABEL}`);
    expect(udp.getAttribute('data-unmeasured')).toBe('plan_excluded');
    expect(udp.getAttribute('title')).toBe(VPN_UDP_NOT_ON_PLAN_HINT);
    expect(caps.querySelector('[data-component="caps-overflow"]')).toBeNull();
    expect(caps.textContent).not.toContain('⇢ UDP');
    cleanup();
  });

  it('VACUITY: a paid account’s unmeasured tunnel still reads "⇢ UDP" (not measured yet)', () => {
    const p = cardProps({ planExcludesVpn: false });
    const udp = capabilityChips(p).eligible.find((c) => c.key === 'udp');
    expect(udp?.text).toBe('⇢ UDP');
  });
});

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
    proxyAddress: 'proxy.example.com:1080',
    locationLabel: 'Netherlands',
    probed: true,
    udp: 'ok',
    latencyMs: 42,
    folder: '',
    tags: [],
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
function tableProps(rows: ProfileTableRow[]): ProfilesTableProps {
  return {
    rows,
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
  };
}

describe('4 — the list’s Network cell draws the card’s chips', () => {
  it('CRITICAL the QUIC chip is the card’s own chip for the same proxy — text, tone and hover', () => {
    const card = cardProps({
      vpn: false,
      probed: true,
      capabilities: OK_UDP,
      latencyMs: 40,
      quicProbe: true,
    });
    const quic = capabilityChips(card).eligible.find((c) => c.key === 'quic');
    expect(quic?.text).toBe('✓ QUIC');
    render(
      <ProfilesTable
        {...tableProps([
          row({
            quic: 'ok',
            quicChip: {
              text: quic!.text,
              className: quic!.className,
              title: quic!.title,
              attrs: quic!.attrs,
            },
          }),
        ])}
      />,
    );
    const chip = document.querySelector('[data-component="list-quic-chip"]') as HTMLElement;
    expect(chip.textContent).toBe('✓ QUIC');
    expect(chip.getAttribute('title')).toBe(quic!.title);
    for (const cls of quic!.className.split(/\s+/)) expect(chip.className).toContain(cls);
    expect(screen.getByText('Network')).toBeTruthy();
    cleanup();
  });

  it('with no chip on the card, the cell states "— QUIC" — and the plan, on a plan without VPN', () => {
    render(<ProfilesTable {...tableProps([row({ vpn: true, udp: 'unknown' })])} />);
    let chip = document.querySelector('[data-component="list-quic-chip"]') as HTMLElement;
    expect(chip.textContent).toBe('— QUIC');
    expect(chip.getAttribute('title')).toMatch(/not measured yet/);
    cleanup();
    render(
      <ProfilesTable
        {...tableProps([row({ vpn: true, udp: 'unknown', planExcludesVpn: true })])}
      />,
    );
    chip = document.querySelector('[data-component="list-quic-chip"]') as HTMLElement;
    expect(chip.getAttribute('data-unmeasured')).toBe('plan_excluded');
    // …and says the plan in the same words as the Proxies tab's QUIC chip.
    expect(chip.textContent).toBe(`— QUIC · ${NOT_ON_THIS_PLAN_LABEL}`);
    const udp = document.querySelector('[data-udp]') as HTMLElement;
    expect(udp.textContent).toBe(UDP_NOT_ON_PLAN_CHIP);
    expect(udp.getAttribute('title')).toBe(VPN_UDP_NOT_ON_PLAN_HINT);
    cleanup();
  });

  it('VACUITY: a row with no proxy shows no network chips at all', () => {
    render(<ProfilesTable {...tableProps([row({ hasProxy: false, udp: 'unknown' })])} />);
    expect(document.querySelector('[data-component="list-quic-chip"]')).toBeNull();
    expect(document.querySelector('[data-component="proxy-os-fingerprint"]')).toBeNull();
    cleanup();
  });
});
