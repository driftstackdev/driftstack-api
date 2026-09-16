// The .ovpn paste box offers to add a missing `client` line.
//
// ⛔ THE DEAD END THIS CLOSES. The control plane refuses any .ovpn with no `client`
// line ("This OpenVPN file must be a client configuration: it needs a `client` line.",
// packages/api-types/src/egress.ts) and OpenVPN 2.7 refuses it too — so this is not a
// Driftstack-only rule. One major provider issues every profile without that line. The
// customer pasted it, read a sentence naming a directive, and had no button: the only
// route out was to open the file in a text editor and type one word.
//
// The form already had the affordance — the one-click fix-up beside the hint — but it
// was reachable ONLY from the unsupported-lines branch, which sits AFTER the
// `validateOpenVpnConfig` gate that a client-less file fails. So a paste that could be
// repaired in one keystroke fell out of the handler before the repair path existed.
//
// `client` is shorthand for `tls-client` + `pull`. On a file that already carries a
// `remote` line and declares no server role, both halves are what the file already
// means, which is why `addMissingOpenvpnClientDirective` will make this edit and will
// NOT make it on a `tls-server`/`server` config or one with no `remote`.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARMS 1-5: the `addMissingOpenvpnClientDirective`
//    branch inside `handleOvpnPaste`'s `if (!v.ok)` arm in ProxiesView.tsx. Delete it and
//    the paste falls through to the bare `setVpnHint(v.reason)` it used to hit: the hint
//    still names `client`, but there is no button, the blob is never rewritten, and the
//    row never saves.
// ⛔ WIDEN it — offer the fix whenever `!v.ok`, without consulting the helper — and the
//    VACUITY CONTROLS (arms 6-8, 10) red: a server-side config, a config with no `remote`
//    and an OVERSIZE file would each be offered a repair that is wrong or that does not
//    repair anything. Arm 10 is the one that fails if the branch merely stops consulting
//    `v.code`: the helper says yes to an oversize client-less file, because it counts
//    directives and not bytes.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OpenVpnProxyConfigSchema } from '@driftstack/api-types';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

/** A provider profile exactly as issued: a real endpoint, no role line anywhere. */
const CLIENTLESS = [
  '# Provider profile — generated 2026-09-01',
  'dev tun',
  'proto udp',
  'remote vpn.example.com 1194 udp',
  'resolv-retry infinite',
  'nobind',
  'persist-key',
  'persist-tun',
  'remote-cert-tls server',
  'verb 3',
  '',
].join('\n');

/** The same file with the one line the customer would have typed by hand. */
const WITH_CLIENT = CLIENTLESS.replace('dev tun', 'client\ndev tun');

function emptyOvpnDraft(): ProxyDraft {
  return {
    label: 'frankfurt ovpn',
    scheme: 'openvpn',
    host: '',
    port: 1194,
    username: null,
    password: null,
  };
}

type OnSave = Mock<(d: ProxyDraft) => Promise<void>>;

function mount(): { onSave: OnSave } {
  const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
  render(
    <ProxyForm initial={emptyOvpnDraft()} mode="add" onCancel={() => undefined} onSave={onSave} />,
  );
  return { onSave };
}

function blobBox(): HTMLTextAreaElement {
  const el = screen.getByPlaceholderText(/remote vpn\.example\.com/i);
  if (!(el instanceof HTMLTextAreaElement)) throw new Error('the .ovpn box is not a textarea');
  return el;
}

function paste(text: string): void {
  fireEvent.change(blobBox(), { target: { value: text } });
}

function addClientButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-action="add-ovpn-client-line"]');
}

function hintText(): string {
  return document.querySelector('[data-component="vpn-paste-hint"]')?.textContent ?? '';
}

function addProxy(): HTMLElement {
  return screen.getByRole('button', { name: 'Add proxy' });
}

describe('the .ovpn box offers to add a missing `client` line', () => {
  it('ARM 1 — CRITICAL: pasting a client-less provider profile offers the fix-up, labelled with the edit it actually makes', () => {
    mount();
    paste(CLIENTLESS);
    const button = addClientButton();
    expect(button, 'a client-less config with a remote must offer the fix').not.toBeNull();
    expect(button?.textContent).toBe('Add the missing `client` line');
  });

  it('ARM 2 — the hint says what is wrong and what the app will do about it, in the customer’s terms', () => {
    mount();
    paste(CLIENTLESS);
    expect(hintText()).toMatch(/client/);
    expect(hintText()).toMatch(/can add that line for you/i);
    // It is a problem, not a confirmation — the config is refusable until pressed.
    expect(hintText()).not.toMatch(/^✓/);
  });

  it('ARM 3 — CRITICAL: pressing it rewrites the box, and the `client` line lands at the top of the directive section rather than at the top of the file', () => {
    mount();
    paste(CLIENTLESS);
    fireEvent.click(addClientButton() as HTMLElement);
    expect(blobBox().value).toBe(WITH_CLIENT);
    // Byte-for-byte the customer's file plus one line: the comment header is still
    // first, every directive survives, and the endpoint is untouched.
    expect(blobBox().value.split('\n')[0]).toBe('# Provider profile — generated 2026-09-01');
    expect(blobBox().value).toMatch(/^client$/m);
    expect(blobBox().value).toContain('remote vpn.example.com 1194 udp');
  });

  it('ARM 4 — the form recovers completely: the offer is gone, the endpoint is parsed, and the hint becomes the ✓ confirmation', () => {
    mount();
    paste(CLIENTLESS);
    fireEvent.click(addClientButton() as HTMLElement);
    expect(addClientButton()).toBeNull();
    expect(hintText()).toMatch(/^✓ remote vpn\.example\.com:1194/);
    expect(addProxy()).toBeEnabled();
  });

  it('ARM 5 — CRITICAL: the proxy then SAVES, carrying the repaired blob — and the CONTROL PLANE SCHEMA accepts that blob, which is the refusal this whole path exists to clear', () => {
    const { onSave } = mount();
    paste(CLIENTLESS);
    // The state before the fix is the one the customer was stuck in.
    expect(OpenVpnProxyConfigSchema.safeParse({ config_blob: CLIENTLESS }).success).toBe(false);
    fireEvent.click(addClientButton() as HTMLElement);
    fireEvent.click(addProxy());
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved?.scheme).toBe('openvpn');
    expect(saved?.host).toBe('vpn.example.com');
    expect(saved?.port).toBe(1194);
    expect(saved?.openvpn?.config_blob).toBe(WITH_CLIENT);
    expect(
      OpenVpnProxyConfigSchema.safeParse({ config_blob: saved?.openvpn?.config_blob ?? '' })
        .success,
      'the saved blob must be one the control plane accepts',
    ).toBe(true);
  });

  it('ARM 6 — CRITICAL VACUITY CONTROL: a config that already declares `client` gets no offer and no complaint. Without this arm a handler that offered the fix on every paste would satisfy arms 1-5.', () => {
    mount();
    paste(WITH_CLIENT);
    expect(addClientButton()).toBeNull();
    expect(hintText()).toMatch(/^✓ remote/);
    expect(blobBox().value).toBe(WITH_CLIENT);
  });

  it('ARM 7 — CRITICAL VACUITY CONTROL: a SERVER config is never offered a conversion into a client one. The honest refusal stands instead.', () => {
    mount();
    const serverSide = ['dev tun', 'server 10.8.0.0 255.255.255.0', 'remote 0.0.0.0 1194', ''].join(
      '\n',
    );
    paste(serverSide);
    expect(addClientButton()).toBeNull();
    expect(hintText()).toMatch(/client/);
    expect(blobBox().value).toBe(serverSide);
  });

  it('ARM 8 — CRITICAL VACUITY CONTROL: no `remote` line means no offer. Adding `client` would leave the config refused for the missing endpoint, and a button that does not fix the problem is worse than no button.', () => {
    mount();
    const noRemote = ['dev tun', 'proto udp', 'verb 3', ''].join('\n');
    paste(noRemote);
    expect(addClientButton()).toBeNull();
    expect(blobBox().value).toBe(noRemote);
  });

  it('ARM 9 — the two repairs compose: on a config that is BOTH client-less and script-hooked, the client fix runs first and the auto-strip then clears the hook by itself', () => {
    mount();
    // A hook AND no `client`: the client branch runs first (it is the gate that
    // rejected the paste), and once the file is a valid client config the paste
    // path reaches the unsupported-lines branch and auto-strips. Neither repair
    // swallows the other. ⚠️ This arm asserts NOTHING about the strip BUTTON — the
    // auto-strip fires before the fallback, so no strip button renders here. The
    // button, its handle and its label are arm 11's job.
    paste('dev tun\nremote vpn.example.com 1194\nup /etc/openvpn/up.sh\n');
    expect(addClientButton()?.textContent).toBe('Add the missing `client` line');
    fireEvent.click(addClientButton() as HTMLElement);
    // The auto-strip runs on the now-valid config and removes the hook itself, with
    // the transparent note the paste path always shows.
    expect(blobBox().value).not.toContain('up /etc/openvpn/up.sh');
    expect(hintText()).toMatch(/script directive/i);
  });

  it('ARM 10 — CRITICAL VACUITY CONTROL: an OVERSIZE client-less file gets the honest size refusal and NO button. The repair cannot make a file smaller — it adds a line — so offering it here would promise to fix a size problem by adding bytes.', () => {
    mount();
    // The size check runs BEFORE the `client` check, and the repair helper is
    // size-blind, so a handler that offered the fix on every refusal offers it
    // here: button visible, hint reading "Config is too large (max 256 KB). This
    // file has a server address but never says it is a client configuration.
    // Driftstack can add that line for you", and pressing it hands back a blob 7
    // bytes LARGER that the control plane still refuses. Reachable from the paste
    // box and from the file picker, neither of which caps what it reads.
    const oversize = `# ${'x'.repeat(256 * 1024)}\ndev tun\nremote vpn.example.com 1194 udp\n`;
    paste(oversize);
    expect(addClientButton(), 'adding a line cannot fix a file that is too long').toBeNull();
    expect(hintText()).toBe('Config is too large (max 256 KB).');
    expect(hintText()).not.toMatch(/can add that line for you/i);
    expect(blobBox().value).toBe(oversize);
  });

  it('ARM 11 — CONTROL: the OTHER repair still renders under its OWN handle and its OWN label. The label moved out of literal JSX into the fix-up state that travels with the config, and a button wearing the wrong label is the exact failure that state exists to prevent.', () => {
    mount();
    // `script-security 2` on an otherwise valid client config: the auto-strip
    // deliberately leaves it alone (the control plane lowers it on the way into
    // storage, so rewriting it would announce an edit for nothing), which is the
    // one branch where the explicit strip BUTTON renders.
    paste('client\nremote vpn.example.com 1194\nscript-security 2\n');
    const strip = document.querySelector<HTMLElement>('[data-action="strip-unsupported-ovpn"]');
    expect(
      strip,
      'a refusal the auto-strip cannot clear must still offer the explicit fix',
    ).not.toBeNull();
    expect(strip?.textContent).toBe('Remove unsupported lines (lower script-security to 1)');
    // …and it is the strip, not the client repair: the two never share a handle.
    expect(addClientButton()).toBeNull();
    // Pressing it applies the edit its label describes and nothing else.
    fireEvent.click(strip as HTMLElement);
    expect(blobBox().value).toBe('client\nremote vpn.example.com 1194\nscript-security 1\n');
  });
});
