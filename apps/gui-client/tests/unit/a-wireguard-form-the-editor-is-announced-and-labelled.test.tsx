// (n) N9 — the WireGuard editor's a11y: one <label> per control, an unpolluted field
// name, and a refusal that is announced and coloured like an error.
//
// MEASURED: the textarea, the upload control (itself a <label> wrapping a visually
// hidden file input) and the parse hint all sat inside `<Field>`, which IS a
// `<label className="flex flex-col gap-1">`. Three consequences, all real:
//   • a <label> nested inside a <label> — invalid HTML, and the browser's own
//     label→control association becomes ambiguous;
//   • the textarea's accessible name was the whole subtree: "Paste your wg0.conf — keys,
//     endpoint + allowed IPs auto-fill Upload a wg0.conf file ✓ endpoint wg.example.com:
//     51820" — a button caption and the last parse result glued onto the field's name,
//     changing as the customer types;
//   • the hint had no role and the same muted grey class for BOTH outcomes, so a screen
//     reader never announced "PresharedKey is not a 44-char base64 key …" and a sighted
//     customer had to read the sentence to tell a refusal from a success.
//
// The name arms query by EXACT name on purpose. the-first-profile-can-have-a-proxy-too
// uses a partial regex, which matched the polluted name happily — that is how this
// survived.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const WG_FIELD_NAME = 'Paste your wg0.conf — keys, endpoint + allowed IPs auto-fill';
const OVPN_FIELD_NAME = 'Paste your .ovpn — the remote endpoint auto-fills';

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
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function draft(scheme: 'wireguard' | 'openvpn'): ProxyDraft {
  return {
    label: 'eu-exit',
    scheme,
    host: '',
    port: scheme === 'wireguard' ? 51820 : 1194,
    username: null,
    password: null,
  };
}

function mount(scheme: 'wireguard' | 'openvpn'): void {
  render(
    <ProxyForm
      initial={draft(scheme)}
      mode="add"
      onCancel={() => undefined}
      onSave={vi.fn(() => Promise.resolve())}
    />,
  );
}

/** Every <label> that contains another <label> — invalid HTML, and the reason the field
 *  name was polluted. */
function nestedLabels(): Element[] {
  return [...document.querySelectorAll('label')].filter((l) => l.querySelector('label') !== null);
}

describe('(n) N9 — the wg0.conf field is named by its caption alone', () => {
  it('CRITICAL the textarea resolves by its EXACT caption — not by a caption with the upload button and the last hint glued on', () => {
    mount('wireguard');
    expect(screen.getByRole('textbox', { name: WG_FIELD_NAME })).toBeInTheDocument();
  });

  it('CRITICAL the name stays exact AFTER a paste — the hint used to join the name, so the field renamed itself as the customer typed', () => {
    mount('wireguard');
    fireEvent.change(screen.getByRole('textbox', { name: WG_FIELD_NAME }), {
      target: { value: conf() },
    });
    expect(screen.getByText('✓ endpoint wg.example.com:51820')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: WG_FIELD_NAME })).toBeInTheDocument();
  });

  it('CRITICAL no <label> contains another <label> (the upload control is one, and it was nested inside the field)', () => {
    mount('wireguard');
    expect(nestedLabels().map((l) => l.textContent)).toEqual([]);
  });

  it('the upload control is still there and still reachable — moving it out of the field must not remove it', () => {
    mount('wireguard');
    expect(screen.getByText('Upload a wg0.conf file')).toBeInTheDocument();
  });

  it('the OpenVPN editor has the same shape: exact field name, no nested label', () => {
    mount('openvpn');
    expect(screen.getByRole('textbox', { name: OVPN_FIELD_NAME })).toBeInTheDocument();
    expect(nestedLabels().map((l) => l.textContent)).toEqual([]);
  });
});

describe('(n) N9 — a refusal is announced as an error, a confirmation is a quiet status', () => {
  it('CRITICAL a malformed PresharedKey is an alert carrying the PSK sentence', () => {
    mount('wireguard');
    fireEvent.change(screen.getByRole('textbox', { name: WG_FIELD_NAME }), {
      target: { value: conf('PresharedKey = not-a-key') },
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/PresharedKey is not a 44-char base64 key/);
    expect(alert.className).toMatch(/text-status-error/);
  });

  it('CRITICAL VACUITY CONTROL — a clean paste is a status, NOT an alert. A hint that always carried role="alert" would satisfy the arm above and fail this.', () => {
    mount('wireguard');
    fireEvent.change(screen.getByRole('textbox', { name: WG_FIELD_NAME }), {
      target: { value: conf() },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('✓ endpoint wg.example.com:51820');
    expect(status.className).not.toMatch(/text-status-error/);
  });

  it('an OpenVPN refusal is announced the same way (the branch had the identical structure)', () => {
    mount('openvpn');
    fireEvent.change(screen.getByRole('textbox', { name: OVPN_FIELD_NAME }), {
      target: { value: 'dev tun\nproto udp\n' },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/client/);
  });

  it('and an OpenVPN confirmation is a status, not an alert', () => {
    mount('openvpn');
    fireEvent.change(screen.getByRole('textbox', { name: OVPN_FIELD_NAME }), {
      target: { value: 'client\ndev tun\nproto udp\nremote vpn.example.com 1194\n' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('✓ remote vpn.example.com:1194');
  });
});
