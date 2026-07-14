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
// returns a non-secret diagnostic for the insecure combination. Bootstrap
// passes that same truth table through assertCorsPosture(), which refuses
// production boot instead of continuing with the allow-list bypassed.
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

/** Fail closed on the one forbidden environment pair while preserving the
 * documented development/test WebView escape hatch. */
export function assertCorsPosture(permissiveCors: boolean, nodeEnv: string): void {
  const diagnostic = corsPostureWarning(permissiveCors, nodeEnv);
  if (diagnostic !== null) throw new Error(diagnostic);
}
