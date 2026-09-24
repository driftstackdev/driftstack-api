// The notifications SSE URL and the credential that goes WITH it.
//
// GUI audit #15 — the account key used to ride in this URL (`?ds_token=`),
// because a browser EventSource cannot set headers. Anything between the app and
// the API that logs URLs (a CDN or edge, a TLS-inspecting corporate proxy) then
// saw a key that never expires. The stream is now read with a header-capable
// reader (lib/header-event-source.ts) and the key travels as
// `Authorization: Bearer …`, which the server's requireAuthEventSource reads
// first (apps/server/src/middleware/auth.ts). The URL carries no credential.
//
// Kept dependency-free so the contract is unit-pinned
// (notification-stream-url.test.ts) without the SettingsContext/Tauri chain.
export function notificationStreamUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/v1/account/me/notifications`;
}

/** The headers that authenticate the stream. */
export function notificationStreamHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}
