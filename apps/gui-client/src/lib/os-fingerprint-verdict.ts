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

export interface OsFingerprint {
  os: FingerprintedOs;
  confidence: FingerprintConfidence;
  /** The classifier's one-line reason — shown in the tooltip so a red cell explains itself. */
  reason: string;
}

export type OsVerdictTone = 'match' | 'mismatch' | 'unknown';

export interface OsVerdict {
  tone: OsVerdictTone;
  /** One glyph before the label: ✓ match, ✗ mismatch, — not measured, ? measured but undetermined. */
  glyph: '✓' | '✗' | '—' | '?';
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

/** Pure. `undefined` = never measured (no observer, or the proxy is not stored
 *  on the account so the control plane never tested it). */
export function osFingerprintVerdict(fp: OsFingerprint | undefined): OsVerdict {
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
