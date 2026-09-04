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
 * Returns a multi-line diagnostic string when the error is a fetch network
 * failure; null otherwise. The raw exception is used only for classification
 * and never copied into the result. Caller must use `whitespace-pre-line` on
 * the rendered <p> for the newlines to render.
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
    'The GUI is a control panel — it does NOT run the API server itself. Self-hosted mode just points the GUI at a Driftstack server you operate yourself (this machine or elsewhere).',
    '',
    isLocalhost
      ? '• Start the server: clone driftstackdev/driftstack-api, then `npm install` + `npm run dev` from apps/server/ (listens on http://localhost:3000 by default).'
      : '• Is the server reachable from this machine? (DNS / firewall / VPN?)',
    isLocalhost
      ? '• No server set up? Switch to Cloud mode in Settings and use https://api.driftstack.dev with a key from app.driftstack.io — no install needed.'
      : '• Does the URL use the correct scheme (http vs https)?',
  ];
  return lines.join('\n');
}
