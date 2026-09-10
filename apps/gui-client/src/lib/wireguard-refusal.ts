// WireGuard parity with openvpn-refusal (owner: a real wg0.conf must save AND launch,
// with the same honest, specific feedback). The WG refusal verdict the proxy form's
// submit gate + Save button consult. PURE: it runs the control plane's OWN
// `WireGuardProxyConfigSchema` — the object AccountProxyInputSchema and
// AccountProxyUpdateSchema wrap under `wireguard`, so the form blocks exactly what a
// save would 400 on — and it reports the FIRST issue's message the way the route does
// (`parsed.error.issues[0]?.message` → BadRequestError). Before this the form's only
// VPN gate was openvpnRefusal, which is null for every other scheme, so a mask-less
// `Address = 10.7.0.2` or a `DNS = 10.64.0.1, corp.local` search domain sailed to the
// server and came back as a raw 400 naming no field. Lives in a lib (not the view) so
// it is unit-testable with zero mocks.
import { WireGuardProxyConfigSchema } from '@driftstack/api-types';

export interface WireguardRefusal {
  /** The wg0.conf field the control plane refuses — the schema's own path (`address`,
   *  `dns`, `private_key`, …), or `preshared_key` for a malformed PresharedKey line. */
  field: string;
  /** Why — the server schema's own sentence, so the form says exactly what the 400 would. */
  reason: string;
}

/** A `PresharedKey =` line in the pasted conf, with its value (an inline `# …`/`; …`
 *  trailer stripped). A WELL-FORMED pre-shared key is carried through and honoured by the
 *  fleet, so it is not refused. A MALFORMED one the parser silently drops — and a dropped
 *  PSK the peer requires means the tunnel never establishes, surfacing later as a bare
 *  timeout with no cause. Judged on the RAW text because the block the parser built no
 *  longer holds the line. A commented-out line (`# PresharedKey = …`) is not one: the
 *  anchor admits only whitespace before the key. */
const WG_PRESHARED_KEY_LINE_RE = /^\s*PresharedKey\s*=\s*([^#;]*?)\s*(?:[#;].*)?$/im;
/** Same shape the server enforces for every WireGuard key (44-char base64 curve25519). */
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** The WireGuard block the server would 400 (or the tunnel would fail on), or null when
 *  it is acceptable. Only the wireguard scheme has this surface; every other scheme —
 *  and a form with no built block yet (nothing to gate) — is null.
 *
 *  `wireguard` is the sub-object the form built from the paste (draft.wireguard), typed
 *  as a plain object on purpose: the schema is the judge, not this app's parser type. */
export function wireguardRefusal(
  scheme: string | undefined,
  wireguard: object | undefined,
  rawConf: string,
): WireguardRefusal | null {
  if (scheme !== 'wireguard') return null;
  if (wireguard === undefined) return null;
  const parsed = WireGuardProxyConfigSchema.safeParse(wireguard);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // A failed parse always carries an issue; the fallback still BLOCKS and says so,
    // rather than passing a config the server would refuse.
    if (issue === undefined) {
      return { field: 'wireguard', reason: 'Driftstack refuses this WireGuard config.' };
    }
    const field = issue.path.map(String).join('.');
    return { field: field === '' ? 'wireguard' : field, reason: issue.message };
  }
  const psk = WG_PRESHARED_KEY_LINE_RE.exec(rawConf);
  if (psk !== null && !WG_KEY_RE.test(psk[1] ?? '')) {
    // Honest copy: a MALFORMED key is the only PSK problem this side can diagnose. A
    // wrong-but-well-formed key is indistinguishable from an unreachable endpoint (the
    // handshake simply never authenticates), so no "invalid PSK" claim is ever made for it.
    return {
      field: 'preshared_key',
      reason:
        'PresharedKey is not a 44-char base64 key — fix it or remove the line (a malformed key would be dropped and the tunnel would never connect)',
    };
  }
  return null;
}
