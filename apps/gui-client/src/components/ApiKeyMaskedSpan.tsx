// V-534.R — ApiKeyMaskedSpan presentational primitive.
//
// Renders a Driftstack API key as `ds_live_abcd…wxyz` so views can
// confirm "this is the right key" without exposing the full secret
// on-screen. Used by SettingsView's "connected" banner today (which
// rolls its own mask); standalone primitive keeps the masking rule
// in one place.

export interface ApiKeyMaskedSpanProps {
  /** Plaintext API key, or null when no key is configured. */
  apiKey: string | null | undefined;
  /** Number of leading chars to show (after the prefix). Default 4. */
  visiblePrefixChars?: number;
  /** Number of trailing chars to show. Default 4. */
  visibleSuffixChars?: number;
  /** Class to apply to the wrapping span. */
  className?: string;
}

/**
 * Pure helper exported for tests + non-React callers (e.g. logging
 * lines that should not include the full secret).
 */
export function maskApiKey(
  apiKey: string | null | undefined,
  opts: { visiblePrefixChars?: number; visibleSuffixChars?: number } = {},
): string {
  if (!apiKey) return '—';
  const prefixChars = opts.visiblePrefixChars ?? 4;
  const suffixChars = opts.visibleSuffixChars ?? 4;
  // Driftstack keys carry a stable 9-char `ds_live_` prefix. Show
  // it verbatim, then prefixChars of the random body, then ellipsis,
  // then the last suffixChars.
  const known = ['ds_live_', 'ds_test_', 'whsec_v1_', 'oas_', 'oat_'];
  let prefix = '';
  let body = apiKey;
  for (const p of known) {
    if (apiKey.startsWith(p)) {
      prefix = p;
      body = apiKey.slice(p.length);
      break;
    }
  }
  if (body.length <= prefixChars + suffixChars) {
    return `${prefix}${body}`;
  }
  return `${prefix}${body.slice(0, prefixChars)}…${body.slice(-suffixChars)}`;
}

export function ApiKeyMaskedSpan(props: ApiKeyMaskedSpanProps): JSX.Element {
  const masked = maskApiKey(props.apiKey, {
    ...(props.visiblePrefixChars !== undefined
      ? { visiblePrefixChars: props.visiblePrefixChars }
      : {}),
    ...(props.visibleSuffixChars !== undefined
      ? { visibleSuffixChars: props.visibleSuffixChars }
      : {}),
  });
  const cls = props.className ?? 'font-mono text-sm text-ink-primary';
  return (
    <span className={cls} aria-label="API key (masked)">
      {masked}
    </span>
  );
}
