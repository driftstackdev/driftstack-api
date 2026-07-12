export type SettingsAction =
  | 'save-ai-billing'
  | 'save-provider-key'
  | 'test-provider-key'
  | 'clear-provider-key';

const FALLBACKS: Record<SettingsAction, string> = {
  'save-ai-billing': "Couldn't save the AI billing settings — please try again.",
  'save-provider-key': "Couldn't save your Anthropic key — please try again.",
  'test-provider-key': "Couldn't test your Anthropic key — please try again.",
  'clear-provider-key': "Couldn't clear your Anthropic key — please try again.",
};

/** Customer-facing Settings failures. Raw SDK/transport text remains available
 * in logs, but HTTP codes and network jargon never become the primary UI copy. */
export function friendlySettingsActionError(err: unknown, action: SettingsAction): string {
  const status = (err as { status?: number } | null)?.status;
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';

  if (status === 401 || status === 403 || /unauthorized|forbidden|permission|scope/i.test(raw)) {
    return 'Your Driftstack API key does not have permission for this setting. Check the key and try again.';
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(raw)) {
    return 'Too many requests right now — wait a moment, then try again.';
  }
  if (
    /invalid.*(anthropic|api)?.*key|api key.*invalid|authentication_error|invalid x-api-key/i.test(
      raw,
    )
  ) {
    return 'Anthropic did not accept that key. Check the key, then try again.';
  }
  if (
    /load failed|failed to fetch|network|fetch failed|ECONN|ENOTFOUND|getaddrinfo|timeout|unreachable/i.test(
      raw,
    )
  ) {
    return "Couldn't reach Driftstack — check your connection and try again.";
  }
  if (
    (status !== undefined && status >= 500) ||
    /internal server|bad gateway|service unavailable/i.test(raw)
  ) {
    return 'Driftstack could not complete that change right now — please try again shortly.';
  }
  return FALLBACKS[action];
}
