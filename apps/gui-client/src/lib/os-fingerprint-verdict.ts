// N-2 — the colour rule for a proxy's passive OS fingerprint.
//
// The control plane fingerprints the proxy's OWN TCP stack from the SYN it
// sends (TTL, window, MSS, option order — see apps/server/src/lib/
// tcp-os-fingerprint.ts). Every Driftstack device is an Apple device, so the
// claim the proxy has to match is Darwin: a proxy whose stack looks like
// iOS/macOS is coherent with the phone it fronts, and one that looks like
// Windows or Linux is the mismatch this exists to make visible — "if its
// mismatched, it should be red, and if MAC/IOS then green".
//
// ⛔ `unknown` and "never measured" are neither. Not measured must never render
// green: an operator who cannot tell a blank from a pass reads every blank as
// a pass. The chip carries a third, neutral tone for both.

export const FINGERPRINTED_OS = ['macos-or-ios', 'windows', 'linux', 'bsd', 'unknown'] as const;
export type FingerprintedOs = (typeof FINGERPRINTED_OS)[number];
export const FINGERPRINT_CONFIDENCE = ['high', 'medium', 'low', 'none'] as const;
export type FingerprintConfidence = (typeof FINGERPRINT_CONFIDENCE)[number];

export function isFingerprintedOs(v: unknown): v is FingerprintedOs {
  return typeof v === 'string' && (FINGERPRINTED_OS as readonly string[]).includes(v);
}
export function isFingerprintConfidence(v: unknown): v is FingerprintConfidence {
  return typeof v === 'string' && (FINGERPRINT_CONFIDENCE as readonly string[]).includes(v);
}

/**
 * (o) O3 — WHY a /test result carried no fingerprint. Mirrors the control plane's
 * `os_fingerprint_unavailable` byte for byte (packages/api-types/src/profiles.ts):
 *
 *   vpn_tunnel    an openvpn/wireguard row has no SOCKS5 stack to dial through,
 *                 so there is no SYN to read. NO retry can produce one.
 *   not_observed  the observer tunnel was refused / no SYN was recorded. A retry
 *                 can genuinely help, so this is the ONE cause that still says
 *                 "run Test".
 *   observer_off  this deployment runs no raw-socket observer. No retry helps.
 *
 * A CLOSED set: a value outside it (a newer server) must fall back to today's
 * neutral wording rather than render a cause the chip cannot state truthfully.
 */
export const OS_FINGERPRINT_UNAVAILABLE = ['vpn_tunnel', 'not_observed', 'observer_off'] as const;
export type OsFingerprintUnavailable = (typeof OS_FINGERPRINT_UNAVAILABLE)[number];
export function isOsFingerprintUnavailable(v: unknown): v is OsFingerprintUnavailable {
  return typeof v === 'string' && (OS_FINGERPRINT_UNAVAILABLE as readonly string[]).includes(v);
}

export interface OsFingerprint {
  os: FingerprintedOs;
  confidence: FingerprintConfidence;
  /** The classifier's one-line reason — shown in the tooltip so a red cell explains itself. */
  reason: string;
  /** (o) O3 — set ONLY on the placeholder minted by `unavailableOsFingerprint` for a
   *  result that carried no fingerprint and a machine-readable cause. `os`/`confidence`
   *  are then the honest fillers 'unknown'/'none', and THIS field is what the verdict
   *  branches on first — so the chip says why there is no value instead of "we looked
   *  and could not tell". Never set on a record the control plane actually measured,
   *  which is why it is the discriminator rather than `os === 'unknown'`. */
  unavailable?: OsFingerprintUnavailable;
  /** (o) O4 — set ONLY on `OS_FINGERPRINT_MEASURING`, the sentinel a view passes while
   *  a test THIS client started is in flight. "Measuring" is a claim about work in
   *  progress: it may be rendered from a running probe and from nothing else, never
   *  from mere absence. Never parsed off the wire and never persisted. */
  measuring?: true;
}

export type OsVerdictTone = 'match' | 'mismatch' | 'unknown';

export interface OsVerdict {
  tone: OsVerdictTone;
  /** One glyph before the label: ✓ match, ✗ mismatch, — not measured, ? measured but
   *  undetermined, … a probe this client started is running right now (o) O4. */
  glyph: '✓' | '✗' | '—' | '?' | '…';
  /** Short chip text. */
  label: string;
  /** Tooltip. */
  hint: string;
}

const OS_LABEL: Record<Exclude<FingerprintedOs, 'unknown'>, string> = {
  'macos-or-ios': 'iOS/macOS',
  windows: 'Windows',
  linux: 'Linux',
  bsd: 'BSD',
};

/**
 * (o) O3 — the TRUE sentence for each reported cause. Each one names the cause and
 * offers advice that can actually produce a value; where none can, it says so instead
 * of inventing an action. ⛔ "Run Test" appears in exactly ONE member — `not_observed`,
 * the only cause a retry can clear. Pressing Test on a VPN tunnel, or on a deployment
 * with no observer, can never produce a fingerprint, and telling the customer to press
 * it is the dead-end loop this item exists to close.
 */
const UNAVAILABLE_HINT: Record<OsFingerprintUnavailable, string> = {
  vpn_tunnel:
    'Stack OS not measured: this row is a VPN tunnel, and a tunnel has no SOCKS5 proxy stack for the control plane to dial and fingerprint. No test can produce one here.',
  not_observed:
    'Stack OS not measured: this proxy refused the connection the fingerprint is read from, so it sent no SYN of its own. Run Test again — a proxy that was momentarily refusing can still be fingerprinted.',
  observer_off:
    'Stack OS not measured: stack fingerprinting is switched off on this deployment, so nothing here measures it. No test can produce one.',
};

/** The one-line `reason` carried on the placeholder record, for any consumer that
 *  reads `reason` rather than the verdict's hint. Same fact, shorter. */
const UNAVAILABLE_REASON: Record<OsFingerprintUnavailable, string> = {
  vpn_tunnel: 'a VPN tunnel has no SOCKS5 stack to fingerprint',
  not_observed: 'the proxy refused the connection the fingerprint needs',
  observer_off: 'stack fingerprinting is off on this deployment',
};

/**
 * (o) O3 — mint the placeholder a reported cause travels on. The parser calls this
 * when a reply carried `os_fingerprint_unavailable` and no `os_fingerprint`, so the
 * cause rides the SAME field every existing consumer already carries (the wire parse,
 * the outcome mapper, the cache entry, the chip) and reaches the verdict without a
 * parallel channel that could drift from it.
 *
 * `os: 'unknown'` + `confidence: 'none'` are not a guess dressed as a reading: they
 * say exactly what happened — no OS determined, zero confidence — and `unavailable`
 * is what stops the verdict rendering them as "measured but undetermined".
 */
export function unavailableOsFingerprint(cause: OsFingerprintUnavailable): OsFingerprint {
  return {
    os: 'unknown',
    confidence: 'none',
    reason: UNAVAILABLE_REASON[cause],
    unavailable: cause,
  };
}

/**
 * (o) 2026-09-11 — the cause a VPN row carries FROM ITS OWN SCHEME, for the states in
 * which no reply carries one: before the first Check, while one is in flight, and after
 * a tunnel that failed to come up (a failed/refused outcome drops every server-measured
 * field, the reported cause with it). `vpn_tunnel` is a property of the scheme — there
 * is no SOCKS5 stack behind a tunnel to dial and fingerprint — so a row of this scheme
 * can state it without asking, and the answer is the same one the control plane gives.
 *
 * ⛔ It is a FALLBACK, never an override: a view uses it only where the row has no
 * fingerprint of its own (`osFingerprint ?? …`), so a real reading always wins.
 */
export const VPN_TUNNEL_OS_FINGERPRINT: OsFingerprint = unavailableOsFingerprint('vpn_tunnel');

/** (o) O4 — the sentinel a view passes to the chip while a test IT started is in
 *  flight, and the ONLY input that renders the word "measuring". */
export const OS_FINGERPRINT_MEASURING: OsFingerprint = {
  os: 'unknown',
  confidence: 'none',
  reason: 'a test you started is still running',
  measuring: true,
};

/** Pure. `undefined` = never measured (no observer, or the proxy is not stored
 *  on the account so the control plane never tested it). */
export function osFingerprintVerdict(fp: OsFingerprint | undefined): OsVerdict {
  // (o) O4 — "measuring…" asserts work IN PROGRESS. It is rendered from a probe this
  // client has actually started and from nothing else; absence below says "not
  // measured", which is the honest state of a proxy nobody has tested.
  if (fp?.measuring === true) {
    return {
      tone: 'unknown',
      glyph: '…',
      label: 'OS',
      hint: 'Measuring this proxy’s stack — the test you started is still running.',
    };
  }
  // (o) O3 — a cause the control plane REPORTED outranks the shape of the record it
  // rides on: the placeholder's `os` is 'unknown', but "we looked and could not tell"
  // is a different (and false) statement from "there was nothing here to look at".
  if (fp?.unavailable !== undefined) {
    return { tone: 'unknown', glyph: '—', label: 'OS', hint: UNAVAILABLE_HINT[fp.unavailable] };
  }
  if (fp === undefined) {
    return {
      tone: 'unknown',
      glyph: '—',
      label: 'OS',
      hint: 'Stack OS not measured. Run Test on a proxy that is stored on your account; the control plane fingerprints the proxy’s own TCP stack.',
    };
  }
  if (fp.os === 'unknown') {
    return {
      tone: 'unknown',
      glyph: '?',
      label: 'OS',
      hint: `Stack OS could not be determined — ${fp.reason}`,
    };
  }
  const label = OS_LABEL[fp.os];
  if (fp.os === 'macos-or-ios') {
    return {
      tone: 'match',
      glyph: '✓',
      label,
      hint: `Proxy stack looks like ${label} (${fp.confidence} confidence) — matches the iOS device it fronts. ${fp.reason}`,
    };
  }
  return {
    tone: 'mismatch',
    glyph: '✗',
    label,
    hint: `Proxy stack looks like ${label} (${fp.confidence} confidence) — an iOS device behind a ${label} stack is a detectable mismatch. ${fp.reason}`,
  };
}
