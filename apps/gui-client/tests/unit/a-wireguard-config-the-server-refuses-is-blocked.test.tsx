// WireGuard parity with an-openvpn-config-the-server-refuses-is-blocked (owner: a real
// wg0.conf must save AND launch, with the same honest, specific feedback the .ovpn path
// gives). MEASURED: the proxy form's only VPN gate was openvpnRefusal, which is null for
// every other scheme, so a WireGuard block the control plane 400s (a mask-less
// `Address = 10.7.0.2`, a `DNS = 10.64.0.1, corp.local` search domain) sailed to the
// server and came back as a raw 400 naming no field — and a MALFORMED PresharedKey the
// parser silently dropped saved fine and then never connected, with no cause shown.
// wireguardRefusal is the verdict the submit gate + Save button now consult: it runs the
// server's OWN WireGuardProxyConfigSchema, so its refusals are exact parity with the
// route (which throws the first issue's message), and it reads the RAW conf for a
// malformed PresharedKey the parser would drop before any schema saw it. Zero mocks: the lib is pure, and the rendered arms drive the
// real ProxyForm with an edit-mode draft, so no parser sits between the arm and the gate.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProxyDraft } from '../../src/lib/proxies';
import { wireguardRefusal } from '../../src/lib/wireguard-refusal';
import { ProxyForm } from '../../src/views/ProxiesView';

// Keys the way `wg genkey | wg pubkey` prints them: 43 base64 chars + one `=`.
const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

// The block the form builds from a well-formed wg0.conf — what a save posts.
const VALID = {
  private_key: PRIV,
  peer_public_key: PUB,
  endpoint: 'wg.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
  dns: '10.64.0.1',
};

// The server's own sentences (packages/api-types egress.ts, via the built dist the GUI
// resolves). Pinned verbatim: the whole point is that the form says what the 400 would.
const ADDRESS_REFUSAL = 'address must be a comma-separated list of CIDRs (no newlines)';
const DNS_REFUSAL = 'dns must be a comma-separated list of IP addresses (no newlines)';

/** A raw wg0.conf carrying the given [Peer] extra line, for the raw-text arms. */
function conf(peerExtra = ''): string {
  return [
    '[Interface]',
    `PrivateKey = ${PRIV}`,
    'Address = 10.7.0.2/32',
    'DNS = 10.64.0.1',
    '[Peer]',
    `PublicKey = ${PUB}`,
    peerExtra,
    'Endpoint = wg.example.com:51820',
    'AllowedIPs = 0.0.0.0/0',
  ].join('\n');
}

describe('wireguardRefusal — the WireGuard block the server would refuse', () => {
  it('CRITICAL VACUITY CONTROL — a well-formed block with no PresharedKey is null. The arms below assert a refusal; a gate that refused everything would satisfy them and fail this.', () => {
    expect(wireguardRefusal('wireguard', VALID, conf())).toBeNull();
  });

  it("flags a mask-less Address (the owner's real-world wg0.conf) with the server's OWN field and sentence", () => {
    // wg-quick accepts `Address = 10.7.0.2`; the server's CIDR rule requires the mask
    // WRITTEN. Reverting the schema check makes this null and the raw 400 returns.
    expect(wireguardRefusal('wireguard', { ...VALID, address: '10.7.0.2' }, conf())).toEqual({
      field: 'address',
      reason: ADDRESS_REFUSAL,
    });
  });

  it("flags a DNS search domain (`DNS = 10.64.0.1, corp.local`) on the dns field with the server's sentence", () => {
    expect(
      wireguardRefusal('wireguard', { ...VALID, dns: '10.64.0.1, corp.local' }, conf()),
    ).toEqual({ field: 'dns', reason: DNS_REFUSAL });
  });

  it('is the whole server schema, not a hand-picked field list: a malformed key is named by ITS field', () => {
    const r = wireguardRefusal('wireguard', { ...VALID, private_key: 'PRIV_KEY_AAA' }, conf());
    expect(r?.field).toBe('private_key');
    expect(r?.reason).toMatch(/private_key must be a 44-char base64 curve25519 key/);
  });

  it('accepts a WELL-FORMED PresharedKey line — the parser carries it and the fleet honours it (deployed 2026-09-10), so refusing it would block a config that works', () => {
    expect(wireguardRefusal('wireguard', VALID, conf(`PresharedKey = ${PRIV}`))).toBeNull();
    // Case, spacing and an inline trailer as wg-quick tolerates them — still well-formed.
    expect(
      wireguardRefusal('wireguard', VALID, conf(`presharedkey=${PRIV} # from provider`)),
    ).toBeNull();
  });

  it('flags a MALFORMED PresharedKey line in the RAW conf on the preshared_key field — the parser drops a bad key, and a dropped key the peer requires means the tunnel never connects with no cause shown. A well-formed-but-WRONG key is deliberately not diagnosed: it is indistinguishable from an unreachable endpoint.', () => {
    const r = wireguardRefusal('wireguard', VALID, conf('PresharedKey = not-a-key'));
    expect(r?.field).toBe('preshared_key');
    expect(r?.reason).toMatch(/PresharedKey is not a 44-char base64 key/);
    // A commented-out PresharedKey is not one: the anchor admits only whitespace first.
    expect(wireguardRefusal('wireguard', VALID, conf('# PresharedKey = not-a-key'))).toBeNull();
  });

  it('is null for every other scheme and when there is no built block yet (nothing to gate)', () => {
    const refusable = { ...VALID, address: '10.7.0.2' };
    const psk = conf(`PresharedKey = ${PRIV}`);
    expect(wireguardRefusal('openvpn', refusable, psk)).toBeNull();
    expect(wireguardRefusal('socks5', refusable, psk)).toBeNull();
    expect(wireguardRefusal(undefined, refusable, psk)).toBeNull();
    expect(wireguardRefusal('wireguard', undefined, psk)).toBeNull();
  });
});

// The wiring: the form's submit gate + Save button consult the verdict. Driven with an
// EDIT-mode draft (the stored block, no paste), so the parser is not between the arm and
// the gate — a paste-time normalizer that rewrote the address would otherwise mask a
// reverted gate. ⛔ The pure arms above prove nothing about this half on their own:
// revert only the ProxiesView wiring and every one of them still passes.
describe('the proxy form blocks a WireGuard block the server would refuse', () => {
  const STORED: ProxyDraft = {
    label: 'wg-london',
    scheme: 'wireguard',
    host: 'wg.example.com',
    port: 51820,
    username: null,
    password: null,
    wireguard: VALID,
  };

  type OnSave = Mock<(d: ProxyDraft) => Promise<void>>;

  function mountEditForm(draft: ProxyDraft): { onSave: OnSave } {
    const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
    render(<ProxyForm initial={draft} mode="edit" onCancel={() => undefined} onSave={onSave} />);
    return { onSave };
  }

  function submitForm(save: HTMLElement): void {
    const form = save.closest('form');
    expect(form, 'the Save button is not inside the proxy form').not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
  }

  it('CRITICAL VACUITY CONTROL — an acceptable stored block leaves Save enabled and a submit reaches onSave. The arm below asserts Save is blocked; an edit form that never saved would satisfy it and fail this.', async () => {
    const { onSave } = mountEditForm(STORED);
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute('title');
    submitForm(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("CRITICAL a mask-less stored address disables Save with the server's sentence as the tooltip, and a submit forced past the button surfaces it as the hint and never calls onSave", async () => {
    const { onSave } = mountEditForm({ ...STORED, wireguard: { ...VALID, address: '10.7.0.2' } });
    const save = screen.getByRole('button', { name: 'Save changes' });
    // The Save button half of the gate.
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', `${ADDRESS_REFUSAL} — fix it first`);
    // The handleSubmit half: a submit that bypasses the disabled button (Enter in a
    // field routes here too) must still stop at the gate with the specific reason.
    submitForm(save);
    expect(
      await screen.findByText(
        `${ADDRESS_REFUSAL}. Fix this before saving — Driftstack will refuse this config.`,
      ),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
