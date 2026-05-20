// 2026-05-20 — shared diagnostic for fetch network failures.
//
// Raw WebKit "Load failed" / Chrome "Failed to fetch" / Firefox
// "NetworkError" / Node ECONNREFUSED+ENOTFOUND messages are useless
// to a customer staring at the GUI — they need to know WHICH url
// the SDK tried to reach and what to check. This helper detects
// those network-class failures and produces a multi-line actionable
// message; for every other error type the function returns null so
// the caller's per-view friendlyError can take over (DriftstackError
// status codes carry endpoint-specific copy + recovery hints that
// the generic diagnostic shouldn't override).

/**
 * Returns a multi-line diagnostic string when the error is a fetch
 * network failure; null otherwise. Caller must use `whitespace-pre-line`
 * on the rendered <p> for the newlines to render.
 */
export function diagnosticFetchError(err: unknown, targetUrl: string): string | null {
  const raw =
    err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  const isNetworkFailure =
    /Load failed|Failed to fetch|NetworkError|ECONNREFUSED|fetch failed|ENOTFOUND/i.test(raw);
  if (!isNetworkFailure) return null;
  const isLocalhost = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(targetUrl);
  const lines = [
    `Couldn't reach ${targetUrl}.`,
    '',
    isLocalhost
      ? '• Is the Driftstack API server running on this machine?'
      : '• Is the server reachable from this machine? (DNS / firewall / VPN?)',
    isLocalhost
      ? '• The server defaults to port 3000 — if you started it that way, change the URL in Settings to http://localhost:3000.'
      : '• Does the URL use the correct scheme (http vs https)?',
    `• Underlying error: ${raw}`,
  ];
  return lines.join('\n');
}
