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
