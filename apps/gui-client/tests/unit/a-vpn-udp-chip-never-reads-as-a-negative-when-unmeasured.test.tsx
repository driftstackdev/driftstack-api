// (V6 2026-09-16) ITEM 3 — the rendering half, on the two surfaces that are NOT
// the Proxies grid: the profile card's capability chips and the profiles list's
// UDP cell. (The grid's own chip is pinned in
// a-vpn-udp-chip-renders-three-states-on-the-grid.test.tsx, which needs the
// ProxiesView mock harness and cannot share a file with these.)
//
// ⛔ THE CLAIM UNDER TEST. A VPN row has THREE UDP states and the third is not a
// negative:
//   • measured relay      → a green tick;
//   • measured fall-back  → a muted ⤵, a real verdict about the tunnel;
//   • NOT MEASURED        → its own glyph and its own sentence. It must never
//     say "no UDP", and it must never look like the measured fall-back.
//
// Today every VPN row is in the third state: the node ASSERTS `udp_associate:
// true` on the VPN path and the control plane drops the assertion rather than let
// it light a chip that means "we measured this". So the not-measured arms are the
// ones a customer actually sees, and the measured arms are what lights up when the
// node's contracted three-state reading lands — with no second client release.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS AN ARM HERE:
//  • `capabilityChips`' vpn branch in components/ProfilePhoneCard.tsx — collapse
//    `udpText` back to the unconditional `'⇢ UDP'` and the two MEASURED arms red.
//  • `r.vpn === true && r.udp === 'unknown'` in components/ProfilesTable.tsx —
//    drop the `&& r.udp === 'unknown'` and the list's measured arms red (the
//    tunnel pill swallows the verdict, which is what it did before this item).
//  • `VPN_UDP_NOT_MEASURED_TITLE` / `VPN_UDP_MEASURED_NONE_TITLE` in
//    lib/proxy-check-copy.ts — point the not-measured chip at the "No UDP"
//    sentence and the NEGATIVE-WORDING arm reds, which is the failure this whole
//    item exists to prevent.
//  • `VPN_UDP_NOT_MEASURED_TITLE`'s leading clause — drop "UDP through this
//    tunnel has not been measured yet." and BOTH not-measured arms red (card and
//    list). Measured 2026-09-16: restoring the sentence this constant shipped
//    with ("UDP travels inside the VPN. WebRTC and QUIC use it; run Check VPN to
//    measure QUIC through this VPN.") satisfied every `not.toMatch` in this file
//    while telling the customer their tunnel carries UDP — a claim nothing
//    measured, in the one state that exists because nothing did.

import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { capabilityChips, type CapsInput } from '../../src/components/ProfilePhoneCard';
import { ProfilesTable, type ProfileTableRow } from '../../src/components/ProfilesTable';
import {
  VPN_UDP_MEASURED_NONE_TITLE,
  VPN_UDP_MEASURED_OK_TITLE,
  VPN_UDP_NOT_MEASURED_TITLE,
} from '../../src/lib/proxy-check-copy';

/** A VPN row's caps input: no SOCKS5 capabilities (a tunnel has none) and a
 *  tunnel the fleet brought up, so the caps region is the measured one. */
function vpnCaps(over: Partial<CapsInput> = {}): CapsInput {
  return {
    hasProxy: true,
    capabilities: null,
    vpn: true,
    latencyMs: 61,
    testing: false,
    ...over,
  };
}

function udpChip(input: CapsInput): {
  text: string;
  title: string;
  attr: string | undefined;
  className: string;
} {
  const chip = capabilityChips(input).eligible.find((c) => c.key === 'udp');
  if (chip === undefined) throw new Error('the VPN row rendered no UDP chip at all');
  return {
    text: chip.text,
    title: chip.title,
    attr: chip.attrs['data-udp'],
    className: chip.className,
  };
}

describe("the profile card's VPN UDP chip has three states", () => {
  it('CRITICAL not measured — its OWN glyph, and a sentence that never says "no UDP"', () => {
    const chip = udpChip(vpnCaps());
    expect(chip.text).toBe('⇢ UDP');
    expect(chip.attr).toBe('tunnel');
    expect(chip.title).toBe(VPN_UDP_NOT_MEASURED_TITLE);
    // ⛔ THE POSITIVE HALF, and the one this file shipped without. Every other
    // assertion on this sentence is a `not.toMatch`, and the whole family of them
    // is satisfied by a sentence that never mentions measurement at all — which is
    // what it was: "UDP travels inside the VPN. WebRTC and QUIC use it; run Check
    // VPN to measure QUIC through this VPN.", a flat capability claim about the
    // customer's tunnel, in the state that exists because the control plane
    // REFUSED to forward the node's asserted `true` as a reading. The item
    // requires this state to read as "not measured yet"; nothing asserted it did.
    expect(chip.title).toMatch(/not been measured|not measured yet/i);
    // ⛔ THE ASSERTION THIS ITEM IS ABOUT. A customer must never be told their
    // tunnel lacks UDP because nobody looked.
    expect(chip.title).not.toMatch(/no udp/i);
    expect(chip.title).not.toMatch(/not supported/i);
    expect(chip.title).not.toMatch(/falls back/i);
    // …and it must not be mistakable for the measured fall-back below.
    expect(chip.text).not.toBe('⤵ UDP');
  });

  it('CRITICAL a measured false is the NEGATIVE verdict, and it is not the not-measured chip', () => {
    const chip = udpChip(vpnCaps({ udpProbe: false }));
    expect(chip.text).toBe('⤵ UDP');
    expect(chip.attr).toBe('false');
    expect(chip.title).toBe(VPN_UDP_MEASURED_NONE_TITLE);
    // A measured negative MAY say so — that is the difference.
    expect(chip.title).toMatch(/no udp/i);
    expect(chip.title).toMatch(/measured/i);
  });

  it('VACUITY CONTROL a measured true is the green verdict', () => {
    const chip = udpChip(vpnCaps({ udpProbe: true }));
    expect(chip.text).toBe('UDP ✓');
    expect(chip.attr).toBe('true');
    expect(chip.title).toBe(VPN_UDP_MEASURED_OK_TITLE);
    // The ONE green class on this row, and only a measurement may wear it.
    expect(chip.className).not.toBe(udpChip(vpnCaps()).className);
    expect(chip.className).not.toBe(udpChip(vpnCaps({ udpProbe: false })).className);
  });

  it('a MEASURED chip keeps its place in the row; only the identical-on-every-row one yields it', () => {
    // `dropFirst` exists for a chip that carries no per-proxy information. A
    // measured verdict is the reason the row exists — putting it behind the '+N'
    // is the complaint the OS chip was promoted out of on 2026-09-12.
    const unmeasured = capabilityChips(vpnCaps()).eligible.find((c) => c.key === 'udp');
    const measured = capabilityChips(vpnCaps({ udpProbe: false })).eligible.find(
      (c) => c.key === 'udp',
    );
    expect(unmeasured?.dropFirst).toBe(true);
    expect(measured?.dropFirst).toBeUndefined();
  });
});

function listRow(over: Partial<ProfileTableRow> = {}): ProfileTableRow {
  return {
    id: 'p1',
    name: 'amsterdam shopper',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    proxyAddress: 'vpn.example.com:1194',
    locationLabel: 'Netherlands',
    probed: true,
    udp: 'unknown',
    vpn: true,
    latencyMs: 61,
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

function listProps(rows: ReadonlyArray<ProfileTableRow>): Parameters<typeof ProfilesTable>[0] {
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
  } as unknown as Parameters<typeof ProfilesTable>[0];
}

describe("the profiles list's VPN UDP cell has the same three states", () => {
  it('CRITICAL not measured — the routed-through pill, with the SAME sentence the card carries', () => {
    render(<ProfilesTable {...listProps([listRow()])} />);
    const pill = screen.getByText('UDP via tunnel');
    expect(pill.getAttribute('data-udp')).toBe('tunnel');
    expect(pill.getAttribute('title')).toBe(VPN_UDP_NOT_MEASURED_TITLE);
    // …and on this surface too the sentence must STATE the absence, not merely
    // avoid the negative one. The list's visible words are "UDP via tunnel",
    // which on their own read as a capability the row has.
    expect(pill.getAttribute('title') ?? '').toMatch(/not been measured|not measured yet/i);
    expect(pill.getAttribute('title') ?? '').not.toMatch(/no udp/i);
    cleanup();
  });

  it('CRITICAL a measured false renders the NEGATIVE chip, not the routed-through pill', () => {
    // ⛔ The regression this arm exists for: the VPN branch used to be
    // unconditional, so a tunnel a Mac had just measured as carrying NO UDP kept
    // reading "UDP via tunnel" — the verdict swallowed by the pill that means
    // "nothing measured this".
    render(<ProfilesTable {...listProps([listRow({ udp: 'fail' })])} />);
    expect(screen.queryByText('UDP via tunnel')).toBeNull();
    const chip = screen.getByText('⤵');
    expect(chip.getAttribute('title')).toBe(VPN_UDP_MEASURED_NONE_TITLE);
    cleanup();
  });

  it('VACUITY CONTROL a measured true renders the green chip with the tunnel wording', () => {
    render(<ProfilesTable {...listProps([listRow({ udp: 'ok' })])} />);
    expect(screen.queryByText('UDP via tunnel')).toBeNull();
    const chip = screen.getByText('✓');
    expect(chip.getAttribute('title')).toBe(VPN_UDP_MEASURED_OK_TITLE);
    cleanup();
  });

  it('VACUITY CONTROL a SOCKS5 row keeps the exit wording — the tunnel sentences are VPN-only', () => {
    // The direction the real failure goes for a shared-copy fix: pointing every
    // UDP cell at the tunnel sentence would satisfy the arms above and start
    // telling SOCKS5 customers about a tunnel they do not have.
    render(<ProfilesTable {...listProps([listRow({ vpn: false, udp: 'fail' })])} />);
    const chip = screen.getByText('⤵');
    expect(chip.getAttribute('title')).not.toBe(VPN_UDP_MEASURED_NONE_TITLE);
    expect(chip.getAttribute('title') ?? '').toMatch(/UDP not supported/i);
    cleanup();
  });
});
