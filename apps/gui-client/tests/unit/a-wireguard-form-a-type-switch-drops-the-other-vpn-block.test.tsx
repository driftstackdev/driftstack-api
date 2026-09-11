// (n) N1 — a WireGuard ↔ OpenVPN Type switch must leave the draft carrying exactly ONE
// VPN block.
//
// MEASURED: `handleSchemeChange` cleared username/password when switching TO a VPN
// scheme and the VPN blocks only when switching AWAY from one, so a wg0.conf pasted
// before the switch stayed in `draft.wireguard` while the customer pasted their .ovpn
// after it. `addProxy` persists both blocks unconditionally (lib/proxies:147-149 has no
// scheme check — unlike `updateProxy`, which drops the foreign one), and every launch
// through that row then died on the control plane's per-scheme `.strict()` branch:
// "Couldn't set up the proxy … Driftstack said: Unrecognized key(s) in object:
// 'wireguard'". The row saved fine, so nothing in the form ever said why.
//
// The arms drive the REAL ProxyForm through the real parsers (paste → parse → build →
// draft), because the defect lives in the state the paste handlers spread over, not in
// any parser. The last arm pins the CONTRACT the client must satisfy — the server's own
// AccountProxyInputSchema refusing the two-block object — so the reason the drop exists
// cannot quietly stop being true.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountProxyInputSchema } from '@driftstack/api-types';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const WG_CONF = [
  '[Interface]',
  `PrivateKey = ${PRIV}`,
  'Address = 10.7.0.2/32',
  'DNS = 10.64.0.1',
  '[Peer]',
  `PublicKey = ${PUB}`,
  'Endpoint = wg.example.com:51820',
  'AllowedIPs = 0.0.0.0/0',
].join('\n');

const OVPN_CONF = ['client', 'dev tun', 'proto udp', 'remote vpn.example.com 1194'].join('\n');

const EMPTY: ProxyDraft = {
  label: 'eu-exit',
  scheme: 'socks5',
  host: '',
  port: 1080,
  username: null,
  password: null,
};

type OnSave = Mock<(d: ProxyDraft) => Promise<void>>;

function mountAddForm(): { onSave: OnSave } {
  const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
  render(<ProxyForm initial={EMPTY} mode="add" onCancel={() => undefined} onSave={onSave} />);
  return { onSave };
}

function setType(next: 'socks5' | 'http' | 'openvpn' | 'wireguard'): void {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: next } });
}

function pasteWg(text = WG_CONF): void {
  fireEvent.change(screen.getByRole('textbox', { name: /wg0\.conf/i }), {
    target: { value: text },
  });
}

function pasteOvpn(text = OVPN_CONF): void {
  fireEvent.change(screen.getByRole('textbox', { name: /\.ovpn/i }), { target: { value: text } });
}

function submit(): void {
  const save = screen.getByRole('button', { name: /^Add proxy$/ });
  const form = save.closest('form');
  expect(form, 'the Add button is not inside the proxy form').not.toBeNull();
  fireEvent.submit(form as HTMLFormElement);
}

describe('(n) N1 — switching Type keeps only the VPN block that belongs to the new scheme', () => {
  it('CRITICAL VACUITY CONTROL — a WireGuard paste with no switch still reaches onSave WITH its block. Every arm below asserts a block is ABSENT; a form that saved nothing, or one whose paste never landed, would satisfy them and fail this.', async () => {
    const { onSave } = mountAddForm();
    setType('wireguard');
    pasteWg();
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const d = onSave.mock.calls[0]?.[0] as ProxyDraft;
    expect(d.scheme).toBe('wireguard');
    expect(d.wireguard?.endpoint).toBe('wg.example.com:51820');
    expect(d.openvpn).toBeUndefined();
  });

  it('CRITICAL WireGuard → OpenVPN: the saved draft carries the .ovpn block and NO wireguard block (the two-block draft is what the strict server 400s on every launch)', async () => {
    const { onSave } = mountAddForm();
    setType('wireguard');
    pasteWg();
    setType('openvpn');
    pasteOvpn();
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const d = onSave.mock.calls[0]?.[0] as ProxyDraft;
    expect(d.scheme).toBe('openvpn');
    expect(d.openvpn?.config_blob).toContain('remote vpn.example.com 1194');
    expect(d.wireguard, 'the WireGuard block survived the switch to OpenVPN').toBeUndefined();
  });

  it('CRITICAL the mirror order — OpenVPN → WireGuard drops the .ovpn block', async () => {
    const { onSave } = mountAddForm();
    setType('openvpn');
    pasteOvpn();
    setType('wireguard');
    pasteWg();
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const d = onSave.mock.calls[0]?.[0] as ProxyDraft;
    expect(d.scheme).toBe('wireguard');
    expect(d.wireguard?.endpoint).toBe('wg.example.com:51820');
    expect(d.openvpn, 'the OpenVPN block survived the switch to WireGuard').toBeUndefined();
  });

  it('WireGuard → OpenVPN → WireGuard leaves an EMPTY box over an EMPTY block: the earlier paste is not saved behind a box that no longer shows it', async () => {
    const { onSave } = mountAddForm();
    setType('wireguard');
    pasteWg();
    setType('openvpn');
    setType('wireguard');
    // The box the customer sees is empty…
    expect(screen.getByRole('textbox', { name: /wg0\.conf/i })).toHaveValue('');
    // …and so is the draft: the submit is refused by validateDraft rather than
    // silently saving the material from before the round trip.
    submit();
    expect(await screen.findByText('Paste a valid wg0.conf configuration.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('switching to a non-VPN scheme still drops both blocks (the pre-existing half of the rule)', async () => {
    const { onSave } = mountAddForm();
    setType('wireguard');
    pasteWg();
    setType('socks5');
    fireEvent.change(screen.getByRole('textbox', { name: /^Host$/ }), {
      target: { value: 'proxy.example.com' },
    });
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const d = onSave.mock.calls[0]?.[0] as ProxyDraft;
    expect(d.scheme).toBe('socks5');
    expect(d.wireguard).toBeUndefined();
    expect(d.openvpn).toBeUndefined();
  });
});

describe('(n) N1 — the contract the client must satisfy: the server refuses a two-block create', () => {
  const COMMON = { label: 'eu-exit', host: 'wg.example.com', port: 51820 };
  const WG_BLOCK = {
    private_key: PRIV,
    peer_public_key: PUB,
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
    dns: '10.64.0.1',
  };
  const OVPN_BLOCK = { config_blob: OVPN_CONF };

  it('VACUITY CONTROL — each single-block create is accepted, so the refusal below is about the SECOND block and not about the fixture', () => {
    expect(
      AccountProxyInputSchema.safeParse({ ...COMMON, scheme: 'openvpn', openvpn: OVPN_BLOCK })
        .success,
    ).toBe(true);
    expect(
      AccountProxyInputSchema.safeParse({ ...COMMON, scheme: 'wireguard', wireguard: WG_BLOCK })
        .success,
    ).toBe(true);
  });

  it('CRITICAL an openvpn create carrying a wireguard block is refused as an unrecognized key — this is the 400 the launch dialog reported as "Unrecognized key(s) in object: \'wireguard\'"', () => {
    const parsed = AccountProxyInputSchema.safeParse({
      ...COMMON,
      scheme: 'openvpn',
      openvpn: OVPN_BLOCK,
      wireguard: WG_BLOCK,
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(JSON.stringify(issue)).toContain('wireguard');
  });

  it('CRITICAL and the mirror: a wireguard create carrying an openvpn block is refused too', () => {
    const parsed = AccountProxyInputSchema.safeParse({
      ...COMMON,
      scheme: 'wireguard',
      wireguard: WG_BLOCK,
      openvpn: OVPN_BLOCK,
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(JSON.stringify(issue)).toContain('openvpn');
  });
});
