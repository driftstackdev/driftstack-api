// Builds the notifications SSE URL for the GUI panel's EventSource.
//
// EventSource can't set an Authorization header, so the bearer (the account
// API key) rides in the `?ds_token=` query param — the server's
// requireAuthEventSource contract (apps/server/src/middleware/auth.ts), the
// same param the SSE routes (/v1/account/me/notifications, the agent-sessions
// livekit-token stream) read. A prior `?token=` shipped and silently 401'd
// every notification stream; this lives in its own dependency-free module so
// the param name is unit-pinned (notification-stream-url.test.ts) and can't
// drift back — importing the hook itself pulls the SettingsContext/Tauri chain
// that doesn't load under jsdom.
export function notificationStreamUrl(baseUrl: string, apiKey: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/v1/account/me/notifications?ds_token=${encodeURIComponent(apiKey)}`;
}
