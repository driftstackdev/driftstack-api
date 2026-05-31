// CORS posture guard.
//
// `PERMISSIVE_CORS=true` makes @fastify/cors echo the request Origin
// (`origin: true`) while `credentials: true` stays on — i.e. ANY site
// gets `Access-Control-Allow-Origin: <itself>` + `…-Allow-Credentials:
// true`. It exists as a dev/webview escape hatch (Tauri custom-scheme
// pages, some in-app browsers) and is documented as opt-in because it
// widens the CSRF/cross-origin surface.
//
// In production that flag must never be on: the env-configured
// `CORS_ALLOWED_ORIGINS` allow-list is the prod boundary. This helper
// returns a loud warning string when the insecure combination is
// detected so the misconfiguration surfaces at boot (logged at error
// level → log search + Sentry breadcrumbs) instead of silently shipping.
//
// See docs/internal/2026-05-31-permissive-cors-in-prod.md.
export function corsPostureWarning(permissiveCors: boolean, nodeEnv: string): string | null {
  if (permissiveCors && nodeEnv === 'production') {
    return (
      'INSECURE CORS: PERMISSIVE_CORS=true in production echoes any request ' +
      'Origin with Access-Control-Allow-Credentials:true — any site can make ' +
      'credentialed cross-origin requests. Set PERMISSIVE_CORS=false and rely on ' +
      'the CORS_ALLOWED_ORIGINS allow-list. ' +
      'See docs/internal/2026-05-31-permissive-cors-in-prod.md'
    );
  }
  return null;
}
