// (n) N7 — a WireGuard refusal must name a line the customer can find in their wg0.conf.
//
// MEASURED: `vpnRefusalMessage` threw `WireguardRefusal.field` away and printed the
// reason alone. Two things reached the customer through that hole:
//   • zod's DEFAULT length sentence. api-types declares `.max()` BEFORE `.regex()` on
//     allowed_ips/address/dns with no message on the `.max`, so a split-tunnel conf whose
//     AllowedIPs list exceeds 1024 chars after the parser's ", " join disabled Save with
//     the tooltip "String must contain at most 1024 character(s) — fix it first". No
//     field, no line, nothing to act on.
//   • the API's WIRE names. `private_key`, `peer_public_key`, `allowed_ips` appear
//     NOWHERE in a wg0.conf — the file says PrivateKey, [Peer] PublicKey, AllowedIPs —
//     so the sentence named a line the customer's file does not contain.
//
// The CONTROL arm is the other half of the rule: `address` and `dns` differ from
// `Address` and `DNS` only by case, so the server's own sentence already points at a
// findable line and is passed through untouched. A translation layer that rewrote
// everything would be just as wrong in the other direction.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const VALID = {
  private_key: PRIV,
  peer_public_key: PUB,
  endpoint: 'wg.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
  dns: '10.64.0.1',
};

/** A well-formed CIDR list over the schema's 1024-char cap — the split-tunnel conf a
 *  provider hands out, which is refused for LENGTH and not for shape. */
const LONG_ALLOWED_IPS = Array.from({ length: 80 }, (_, i) => `10.${i}.0.0/16`).join(', ');

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

function mount(draft: ProxyDraft): { onSave: OnSave } {
  const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
  render(<ProxyForm initial={draft} mode="edit" onCancel={() => undefined} onSave={onSave} />);
  return { onSave };
}

function saveTitle(): string {
  return screen.getByRole('button', { name: 'Save changes' }).getAttribute('title') ?? '';
}

describe('(n) N7 — the Save tooltip names the wg0.conf line, not the API field', () => {
  it('CRITICAL VACUITY CONTROL — an acceptable block leaves Save enabled with NO tooltip. Every arm below reads a tooltip; a form that always carried one would satisfy them and fail this.', () => {
    expect(LONG_ALLOWED_IPS.length).toBeGreaterThan(1024);
    mount(STORED);
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute('title');
  });

  it('CRITICAL an over-long AllowedIPs list names AllowedIPs and the cap — never zod\'s "String must contain at most 1024 character(s)"', () => {
    mount({ ...STORED, wireguard: { ...VALID, allowed_ips: LONG_ALLOWED_IPS } });
    expect(saveTitle()).toMatch(/AllowedIPs/);
    expect(saveTitle()).toMatch(/1024/);
    expect(saveTitle()).not.toMatch(/String must contain/);
    expect(saveTitle()).not.toMatch(/allowed_ips/);
  });

  it("CRITICAL a malformed peer key names '[Peer] PublicKey' — the line in the file — and never the wire name peer_public_key", () => {
    mount({ ...STORED, wireguard: { ...VALID, peer_public_key: 'bad' } });
    expect(saveTitle()).toContain('[Peer] PublicKey');
    expect(saveTitle()).toMatch(/44-char base64 curve25519 key/);
    expect(saveTitle()).not.toMatch(/peer_public_key/);
  });

  it('a malformed private key names PrivateKey, never private_key', () => {
    mount({ ...STORED, wireguard: { ...VALID, private_key: 'PRIV_KEY_AAA' } });
    expect(saveTitle()).toMatch(/^PrivateKey must be/);
    expect(saveTitle()).not.toMatch(/private_key/);
  });

  it("CRITICAL CONTROL — Address and DNS differ from the server's field names only by case, so the server's OWN sentence is passed through verbatim rather than re-worded", () => {
    mount({ ...STORED, wireguard: { ...VALID, address: '10.7.0.2' } });
    expect(saveTitle()).toBe(
      'address must be a comma-separated list of CIDRs (no newlines) — fix it first',
    );
  });

  it('the submit hint carries the same line-named sentence as the tooltip (one builder, two surfaces)', async () => {
    const { onSave } = mount({ ...STORED, wireguard: { ...VALID, peer_public_key: 'bad' } });
    const form = screen.getByRole('button', { name: 'Save changes' }).closest('form');
    fireEvent.submit(form as HTMLFormElement);
    const hint = await screen.findByRole('alert');
    expect(hint.textContent).toContain('[Peer] PublicKey');
    expect(hint.textContent).toContain('Fix this before saving');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('CRITICAL the PASTE-time hint says it too: a conf whose AllowedIPs list is over the cap is refused by line name at paste, not with a green ✓', async () => {
    mount({ ...STORED, wireguard: undefined });
    fireEvent.change(screen.getByRole('textbox', { name: /wg0\.conf/i }), {
      target: {
        value: [
          '[Interface]',
          `PrivateKey = ${PRIV}`,
          'Address = 10.7.0.2/32',
          '[Peer]',
          `PublicKey = ${PUB}`,
          'Endpoint = wg.example.com:51820',
          `AllowedIPs = ${LONG_ALLOWED_IPS}`,
        ].join('\n'),
      },
    });
    const hint = await screen.findByRole('alert');
    expect(hint.textContent).toMatch(/AllowedIPs/);
    expect(hint.textContent).not.toMatch(/String must contain/);
    expect(screen.queryByText(/✓ endpoint/)).toBeNull();
  });
});
