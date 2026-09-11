// (o) O6 — a legacy OpenVPN row that cannot be saved, and would not say why.
//
// The paste and upload paths auto-strip before any gate, so nothing refusable can be
// CREATED today. A row created by a build that predates that gate is a different
// animal: `toDraft` seeds `draft.openvpn.config_blob` verbatim, and ProxyForm's only
// other effect is the `inert` lock — so nothing normalized it on mount. MEASURED, the
// customer's state on opening Edit was:
//   • Save disabled (`vpnRefusal !== null`), its `title` the only trace;
//   • `vpnHint` null, so NO visible message anywhere on the form;
//   • the "Remove unsupported lines" button absent, because `vpnFixable`'s only
//     reachable setter lives inside `handleSubmit`, which a disabled Save cannot reach;
//   • every launch re-PUTting the raw blob to a certain 400.
// The only escape was typing a character into the textarea to re-fire the paste path.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARMS 1-4: the mount effect in ProxyForm
//    (`const auto = openvpnAutoStrip('openvpn', seeded); … handleOvpnPaste(auto.config,
//    auto.note)`). Delete it and the seeded blob stays refusable: Save is disabled again,
//    there is no note, and the textarea still carries `script-security 2`.
// ⛔ Widen it — strip unconditionally instead of `if (auto === null) return` — and the
//    VACUITY CONTROL (arms 5-6) reds: a clean stored config would be rewritten and would
//    wear an adjustment note describing an adjustment that did not happen. That is the
//    direction the real failure goes for a self-healing edit.
//
// ⛔ 2026-09-11 — WIREGUARD SAT IN THE SAME DEAD END and the effect returned before it
//    (`if (initial.scheme !== 'openvpn') return`). A stored WG block is judged on mount by
//    the control plane's OWN schema (`wireguardRefusal` over `initial.wireguard`), so a
//    row written by a build predating wireguard-refusal.ts — a mask-less
//    `Address = 10.7.0.2` — opens with Save dead, no visible message, no fix button, and
//    a textarea that is EMPTY by design (N4: it is a REPLACE field). Strictly worse than
//    the OpenVPN case, where the offending blob is at least on screen.
//    There is deliberately no auto-fix: completing an address or dropping a DNS entry
//    changes where the tunnel routes. The heal is the honest one — say what is refused,
//    in the server's words, and name the action that clears it.
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARMS 8-10: the `if (initial.scheme ===
//    'wireguard')` arm of that same effect. Delete it and the form is silent again.
//    Widen it — set the hint without consulting `wireguardRefusal` — and the WG VACUITY
//    CONTROL (arm 11) reds: a perfectly good stored config would be announced as refused.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

/** A config a build predating the client-side gate happily stored: a bare
 *  `script-security 2` with no script directives at all. The control plane refuses it
 *  (webhook-target-guard), and the fleet forces `--script-security 1` anyway — which is
 *  why lowering it changes nothing about how the tunnel connects. */
const LEGACY_BLOB = ['client', 'dev tun', 'remote vpn.example.com 1194 udp', 'script-security 2']
  .join('\n')
  .concat('\n');

const CLEAN_BLOB = ['client', 'dev tun', 'remote vpn.example.com 1194 udp'].join('\n').concat('\n');

function storedRow(blob: string): ProxyDraft {
  return {
    label: 'legacy-ovpn',
    scheme: 'openvpn',
    host: 'vpn.example.com',
    port: 1194,
    username: null,
    password: null,
    openvpn: { config_blob: blob },
  };
}

type OnSave = Mock<(d: ProxyDraft) => Promise<void>>;

function mount(blob: string): { onSave: OnSave } {
  const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
  render(
    <ProxyForm initial={storedRow(blob)} mode="edit" onCancel={() => undefined} onSave={onSave} />,
  );
  return { onSave };
}

function save(): HTMLElement {
  return screen.getByRole('button', { name: 'Save changes' });
}
function blobBox(): HTMLTextAreaElement {
  const el = screen.getByPlaceholderText(/remote vpn\.example\.com/i);
  if (!(el instanceof HTMLTextAreaElement)) throw new Error('the .ovpn box is not a textarea');
  return el;
}

describe('(o) O6 — opening a stored refusable OpenVPN row heals it, and says what it changed', () => {
  it('ARM 1 — CRITICAL: Save is ENABLED on mount, with no refusal tooltip — the dead end is gone', () => {
    mount(LEGACY_BLOB);
    expect(save()).toBeEnabled();
    expect(save()).not.toHaveAttribute('title');
  });

  it('ARM 2 — the adjustment is VISIBLE, not silent: the same transparent note the paste path shows', () => {
    mount(LEGACY_BLOB);
    const hint = document.querySelector('[data-component="vpn-paste-hint"]');
    expect(hint).not.toBeNull();
    const text = hint?.textContent ?? '';
    expect(text).toMatch(/lowered script-security to 1/i);
    expect(text).toMatch(/never runs VPN scripts/i);
    // It is a confirmation, not an alert — the row is now saveable.
    expect(hint?.getAttribute('role')).toBe('status');
  });

  it('ARM 3 — the seeded blob itself is normalized in the box the customer is looking at', () => {
    mount(LEGACY_BLOB);
    expect(blobBox().value).not.toMatch(/script-security\s+2/);
    expect(blobBox().value).toMatch(/script-security\s+1/);
    // Everything else survives: this strips what the control plane refuses, nothing more.
    expect(blobBox().value).toMatch(/remote vpn\.example\.com 1194 udp/);
    expect(blobBox().value).toMatch(/^client$/m);
  });

  it('ARM 4 — the row actually SAVES, and saves the healed blob rather than the refusable one', () => {
    const { onSave } = mount(LEGACY_BLOB);
    save().click();
    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = onSave.mock.calls[0]?.[0];
    expect(draft?.openvpn?.config_blob).not.toMatch(/script-security\s+2/);
    expect(draft?.scheme).toBe('openvpn');
    expect(draft?.host).toBe('vpn.example.com');
    expect(draft?.port).toBe(1194);
  });

  it('ARM 5 — CRITICAL VACUITY CONTROL: a CLEAN stored config is not rewritten — byte for byte what was stored', () => {
    mount(CLEAN_BLOB);
    expect(blobBox().value).toBe(CLEAN_BLOB);
  });

  it('ARM 6 — CRITICAL VACUITY CONTROL: a clean stored config shows NO adjustment note (nothing was adjusted)', () => {
    mount(CLEAN_BLOB);
    expect(document.querySelector('[data-component="vpn-paste-hint"]')).toBeNull();
    expect(save()).toBeEnabled();
  });

  it('ARM 7 — CONTROL: the heal does not invent missing material. An external cert reference is untouched and keeps its own honest refusal.', () => {
    // `openvpnAutoStrip` deliberately does not touch a file reference, so this row is
    // still refused — correctly, and with a message, which is the whole difference.
    const withCert = CLEAN_BLOB.concat('cert /etc/openvpn/client.crt\n');
    mount(withCert);
    expect(blobBox().value).toBe(withCert);
    expect(save()).toBeDisabled();
    // The message IS the difference: without it this is the original dead end (a
    // greyed button whose `title` is the only trace). It names the line, the reason
    // and the action that clears it. MUTATION: drop the `openvpnRefusal` branch from
    // the mount effect's `auto === null` arm → no hint renders → red.
    const hint = document.querySelector('[data-component="vpn-paste-hint"]');
    expect(hint, 'a refusable row must say why on sight').not.toBeNull();
    expect(hint?.textContent).toMatch(/^Line \d+: /);
    expect(hint?.textContent).toMatch(/replace it/);
  });
});

describe('(o) O6 — a stored WireGuard row the control plane refuses says so, on sight', () => {
  // Keys as `wg genkey | wg pubkey` prints them (43 base64 chars + '=').
  const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
  const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

  /** A row stored before the client-side gate existed: `Address = 10.7.0.2`, no mask —
   *  the exact case wireguard-refusal.ts's header cites as having sailed to the server,
   *  and which lib/proxies stored locally regardless of the 400. */
  function storedWg(address: string): ProxyDraft {
    return {
      label: 'legacy-wg',
      scheme: 'wireguard',
      host: 'wg.example.com',
      port: 51820,
      username: null,
      password: null,
      wireguard: {
        private_key: PRIV,
        peer_public_key: PUB,
        endpoint: 'wg.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address,
      },
    };
  }

  function mountWg(address: string): void {
    render(
      <ProxyForm
        initial={storedWg(address)}
        mode="edit"
        onCancel={() => undefined}
        onSave={vi.fn(() => Promise.resolve())}
      />,
    );
  }

  function hint(): Element | null {
    return document.querySelector('[data-component="vpn-paste-hint"]');
  }

  it("ARM 8 — CRITICAL: the refusal is VISIBLE on mount, in the control plane's own words, naming the field", () => {
    mountWg('10.7.0.2');
    const text = hint()?.textContent ?? '';
    expect(hint()).not.toBeNull();
    // The server schema's own sentence, via wireguardRefusal — not a paraphrase.
    expect(text).toMatch(/address/i);
    expect(text).toMatch(/CIDR/i);
  });

  it('ARM 9 — it names an action that CAN clear it, and never one that cannot', () => {
    mountWg('10.7.0.2');
    const text = hint()?.textContent ?? '';
    // The textarea is a REPLACE field (N4), so replacing the conf is the real escape.
    expect(text).toMatch(/paste or upload/i);
    // ⛔ never the OpenVPN affordance, which does not exist on this form.
    expect(document.querySelector('[data-action="strip-unsupported-ovpn"]')).toBeNull();
  });

  it('ARM 10 — the message is an ERROR, not a ✓ confirmation: nothing was fixed', () => {
    mountWg('10.7.0.2');
    // The form derives the tone from the leading glyph; a heal that silently rewrote the
    // config would show the paste path's '✓'. Nothing was rewritten here.
    // ⛔ The presence assertion comes FIRST: without it an absent hint (the defect this
    // arm is part of closing) satisfies "does not start with ✓" vacuously.
    expect(hint()).not.toBeNull();
    expect(hint()?.textContent ?? '').not.toMatch(/^✓/);
    expect(save()).toBeDisabled();
  });

  it('ARM 11 — CRITICAL VACUITY CONTROL: a VALID stored WireGuard row shows NO message and saves', () => {
    // The direction the real failure goes: announcing a refusal from the scheme alone
    // would put "Driftstack refuses this" on every stored WG row in the product.
    mountWg('10.7.0.2/32');
    expect(hint()).toBeNull();
    expect(save()).toBeEnabled();
  });
});
