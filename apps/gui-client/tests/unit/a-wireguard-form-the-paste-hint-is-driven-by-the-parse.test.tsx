// (n) N10 — the WireGuard paste-time hint had no test at all.
//
// MEASURED: `handleWgPaste` ends with
//   `setVpnHint(refusal !== null ? <reason> : \`✓ endpoint ${host}:${port}\`)`
// and NOTHING drove it. The only WireGuard paste arms in the suite
// (the-first-profile-can-have-a-proxy-too) assert the validateDraft error
// "Paste a valid wg0.conf configuration."; the refusal arms in
// a-wireguard-config-the-server-refuses-is-blocked say so themselves — they are driven
// with an EDIT-mode draft "so the parser is not between the arm and the gate". A grep for
// '✓ endpoint' across apps/gui-client/tests returned nothing. OpenVPN's twin IS pinned
// (proxies-view-edit-vpn: '✓ remote vpn.example.com:1194').
//
// So reverting that line to an unconditional '✓ endpoint …' would leave a green check
// beside a Save button the same refusal has just disabled — a config the customer is told
// is fine and cannot save — with every suite green. These arms are the paste-driven half:
// the hint and the Save gate must agree, on the SAME pasted text.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

/** A well-formed CIDR list past the schema's 1024-char cap. */
const LONG_ALLOWED_IPS = Array.from({ length: 80 }, (_, i) => `10.${i}.0.0/16`).join(', ');

/** A wg0.conf with the given [Peer] extra line and AllowedIPs list. */
function conf(opts: { peerExtra?: string; allowedIps?: string } = {}): string {
  return [
    '[Interface]',
    `PrivateKey = ${PRIV}`,
    'Address = 10.7.0.2/32',
    'DNS = 10.64.0.1',
    '[Peer]',
    `PublicKey = ${PUB}`,
    ...(opts.peerExtra !== undefined ? [opts.peerExtra] : []),
    'Endpoint = wg.example.com:51820',
    `AllowedIPs = ${opts.allowedIps ?? '0.0.0.0/0'}`,
  ].join('\n');
}

const NEW_WG: ProxyDraft = {
  label: 'wg-london',
  scheme: 'wireguard',
  host: '',
  port: 51820,
  username: null,
  password: null,
};

function mount(): void {
  render(
    <ProxyForm
      initial={NEW_WG}
      mode="add"
      onCancel={() => undefined}
      onSave={vi.fn(() => Promise.resolve())}
    />,
  );
}

function paste(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: /wg0\.conf/i }), {
    target: { value: text },
  });
}

function addButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Add proxy' });
}

describe('(n) N10 — the paste hint and the Save gate answer the same pasted conf', () => {
  it('CRITICAL VACUITY CONTROL — a clean conf shows the ✓ endpoint hint and leaves Save enabled. Every arm below asserts a refusal; a form that refused every paste would satisfy them and fail this.', () => {
    mount();
    paste(conf());
    expect(screen.getByText('✓ endpoint wg.example.com:51820')).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
    expect(addButton()).not.toHaveAttribute('title');
  });

  it('CRITICAL a pasted conf with a MALFORMED PresharedKey shows the PSK sentence — never ✓ — and Save is disabled with the same reason', () => {
    mount();
    paste(conf({ peerExtra: 'PresharedKey = not-a-key' }));
    expect(screen.getByRole('alert').textContent).toMatch(
      /PresharedKey is not a 44-char base64 key/,
    );
    expect(screen.queryByText(/✓ endpoint/)).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(addButton().getAttribute('title')).toMatch(/PresharedKey is not a 44-char base64 key/);
  });

  it("CRITICAL a pasted conf the PARSER accepts and the SERVER's schema refuses (a split-tunnel AllowedIPs list over the 1024-char cap) shows the refusal, not ✓ endpoint", () => {
    mount();
    // The parser is happy — every entry is a valid CIDR — so this refusal can only come
    // from the schema check the paste handler runs, which is the line under test.
    paste(conf({ allowedIps: LONG_ALLOWED_IPS }));
    expect(screen.getByRole('alert').textContent).toMatch(/AllowedIPs/);
    expect(screen.queryByText(/✓ endpoint/)).toBeNull();
    expect(addButton()).toBeDisabled();
  });

  it('the hint TRACKS the box: a refused paste replaced by a clean one clears the refusal and re-enables Save', () => {
    mount();
    paste(conf({ peerExtra: 'PresharedKey = not-a-key' }));
    expect(addButton()).toBeDisabled();
    paste(conf());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('✓ endpoint wg.example.com:51820')).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it('and back: a clean paste replaced by a refused one drops the ✓ and disables Save again', () => {
    mount();
    paste(conf());
    expect(addButton()).toBeEnabled();
    paste(conf({ peerExtra: 'PresharedKey = not-a-key' }));
    expect(screen.queryByText(/✓ endpoint/)).toBeNull();
    expect(addButton()).toBeDisabled();
  });

  it('a conf the PARSER cannot read at all reports the parser’s reason and never a ✓', () => {
    mount();
    paste('[Interface]\nPrivateKey = nope\n');
    expect(screen.getByRole('alert').textContent).toMatch(/PrivateKey is not a 44-char base64 key/);
    expect(screen.queryByText(/✓ endpoint/)).toBeNull();
    expect(addButton()).toBeEnabled(); // nothing built to refuse…
    fireEvent.submit(addButton().closest('form') as HTMLFormElement);
    // …so the submit gate is what stops it, with the words the form has always used.
    expect(screen.getByText('Paste a valid wg0.conf configuration.')).toBeInTheDocument();
  });
});
