// N1 (owner: OpenVPN "still won't launch/save") — the OVPN refusal verdict, shared by
// the proxy form's submit gate and its guard. PURE: uses only the api-types finders the
// control plane itself enforces, so the form blocks exactly what a save would 400 on —
// a script directive / `script-security >= 2`, or an unresolvable inline cert/key file
// reference. Lives in a lib (not the view) so it is unit-testable with zero mocks.
import {
  findUnsupportedOpenvpnLines,
  findUnresolvableOpenvpnFileReferences,
  stripUnsupportedOpenvpnLines,
} from '@driftstack/api-types';

export interface OpenvpnRefusal {
  /** 1-based line of the first offending directive (for the form's message). */
  line: number;
  /** Why the control plane refuses it — the finder's own sentence. */
  reason: string;
  /** The auto-stripped config a one-click "Remove unsupported lines" would save
   *  (script-security lowered to 1, script directives removed), or null when the
   *  refusal is NOT auto-fixable (an unresolvable file reference the user must edit). */
  fixable: string | null;
}

/** The config the server would 400, or null when it is acceptable. Only OpenVPN has
 *  a refusable-directive surface; every other scheme (and an empty blob) is null. */
export function openvpnRefusal(
  scheme: string | undefined,
  configBlob: string,
): OpenvpnRefusal | null {
  if (scheme !== 'openvpn') return null;
  if (configBlob.trim() === '') return null;
  const hit = findUnsupportedOpenvpnLines(configBlob)[0];
  if (hit !== undefined) {
    const fixed = stripUnsupportedOpenvpnLines(configBlob);
    return {
      line: hit.line,
      reason: hit.reason,
      fixable: fixed.config !== configBlob ? fixed.config : null,
    };
  }
  const ref = findUnresolvableOpenvpnFileReferences(configBlob)[0];
  if (ref !== undefined) return { line: ref.line, reason: ref.reason, fixable: null };
  return null;
}

/** A human summary of what the strip changed, for the transparent auto-apply notice. */
function openvpnAdjustmentNote(removed: ReadonlyArray<{ directive: string }>): string {
  const loweredSecurity = removed.some((r) => r.directive === 'script-security');
  const scripts = removed.filter((r) => r.directive !== 'script-security').length;
  const parts: string[] = [];
  if (loweredSecurity) parts.push('lowered script-security to 1');
  if (scripts > 0)
    parts.push(`removed ${scripts.toString()} script directive${scripts === 1 ? '' : 's'}`);
  return `${parts.join(' and ')} (Driftstack never runs VPN scripts, so this changes nothing about how the VPN connects)`;
}

/** N1 (owner) — auto-normalize an OpenVPN config to the form the control plane accepts,
 *  on ANY entry point (paste OR file upload). `stripUnsupportedOpenvpnLines` lowers
 *  `script-security >= 2` to 1 and removes script directives (up/down/route-up/…) — and
 *  on Driftstack ALL of that is inert: the fleet forces `--script-security 1` and never
 *  invokes user scripts, so removing them changes NOTHING about how the tunnel connects,
 *  it only removes what the control plane refuses. So this auto-applies the whole strip
 *  with a transparent note rather than blocking behind a button. Returns null when nothing
 *  is refusable or for a non-OpenVPN scheme. ⛔ It does NOT invent missing material: a
 *  config that references an EXTERNAL cert/key file (findUnresolvableOpenvpnFileReferences)
 *  still cannot be fixed here — the strip does not touch it, so after auto-apply the paste
 *  flow surfaces that as an honest "include the certificate/key inline" error. */
export function openvpnAutoStrip(
  scheme: string | undefined,
  configBlob: string,
): { config: string; note: string } | null {
  if (scheme !== 'openvpn') return null;
  const dangerous = findUnsupportedOpenvpnLines(configBlob);
  if (dangerous.length === 0) return null;
  const fixed = stripUnsupportedOpenvpnLines(configBlob);
  if (fixed.config === configBlob) return null;
  return { config: fixed.config, note: openvpnAdjustmentNote(fixed.removed) };
}
