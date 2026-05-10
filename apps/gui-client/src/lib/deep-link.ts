// Deep-link URL parser for `driftstack://` custom-scheme handoffs.
//
// The Tauri shell registers `driftstack://` as a custom URL scheme so
// the browser can hand control back to the desktop app after a flow
// completes (CLI authorization, recording load, profile import, etc).
// `@tauri-apps/plugin-deep-link.onOpenUrl` fires whenever the OS
// dispatches one of these URLs to the running instance.
//
// This module is the typed, single-source parser every caller uses to
// turn the raw URL string into a discriminated payload. Each consumer
// (CLI auth flow, profile importer, recording loader) reads the
// `kind` discriminant and acts on the typed fields, instead of each
// caller hand-rolling URL parsing + string-matching.
//
// Scheme shape:
//
//   driftstack://<host>/<path>?<query>
//
// `host` partitions the namespace; `path` partitions within the host.
// Unknown host/path combinations parse to `{ kind: 'unknown' }` and
// callers SHOULD ignore them — the OS may dispatch a URL the running
// app version doesn't understand (forward-compat from a newer
// dashboard issuing a deep-link the older GUI installer doesn't know
// about yet).

export type DeepLinkPayload =
  | { kind: 'cli-authorize'; code: string; state: string }
  | { kind: 'session-open'; sessionId: string }
  | { kind: 'recording-open'; recordingId: string }
  | { kind: 'profile-import'; profileId: string }
  | { kind: 'unknown'; host: string; pathname: string };

export interface DeepLinkParseError {
  reason: 'malformed-url' | 'wrong-scheme' | 'missing-required-param';
  rawUrl: string;
}

export type DeepLinkParseResult =
  | { ok: true; payload: DeepLinkPayload }
  | { ok: false; error: DeepLinkParseError };

const REQUIRED_SCHEME = 'driftstack:';

export function parseDeepLink(rawUrl: string): DeepLinkParseResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: { reason: 'malformed-url', rawUrl } };
  }
  if (parsed.protocol !== REQUIRED_SCHEME) {
    return { ok: false, error: { reason: 'wrong-scheme', rawUrl } };
  }

  const host = parsed.host;
  const pathname = parsed.pathname;
  const params = parsed.searchParams;

  if (host === 'auth' && pathname.startsWith('/callback')) {
    const code = params.get('code');
    const state = params.get('state');
    if (code === null || code.length === 0 || state === null || state.length === 0) {
      return { ok: false, error: { reason: 'missing-required-param', rawUrl } };
    }
    return { ok: true, payload: { kind: 'cli-authorize', code, state } };
  }

  if (host === 'session' && pathname.startsWith('/open')) {
    const sessionId = params.get('session_id');
    if (sessionId === null || sessionId.length === 0) {
      return { ok: false, error: { reason: 'missing-required-param', rawUrl } };
    }
    return { ok: true, payload: { kind: 'session-open', sessionId } };
  }

  if (host === 'recording' && pathname.startsWith('/open')) {
    const recordingId = params.get('recording_id');
    if (recordingId === null || recordingId.length === 0) {
      return { ok: false, error: { reason: 'missing-required-param', rawUrl } };
    }
    return { ok: true, payload: { kind: 'recording-open', recordingId } };
  }

  if (host === 'profile' && pathname.startsWith('/import')) {
    const profileId = params.get('profile_id');
    if (profileId === null || profileId.length === 0) {
      return { ok: false, error: { reason: 'missing-required-param', rawUrl } };
    }
    return { ok: true, payload: { kind: 'profile-import', profileId } };
  }

  return { ok: true, payload: { kind: 'unknown', host, pathname } };
}

// Convenience used by App.tsx-level wiring: parse + dispatch via a
// caller-supplied router. Errors and `unknown` payloads are silently
// dropped to keep the deep-link channel forward-compatible (a newer
// dashboard issuing an unknown deep-link kind doesn't make the GUI
// crash or show a noisy error toast).
export function dispatchDeepLink(
  rawUrl: string,
  router: Partial<{
    onCliAuthorize: (code: string, state: string) => void;
    onSessionOpen: (sessionId: string) => void;
    onRecordingOpen: (recordingId: string) => void;
    onProfileImport: (profileId: string) => void;
  }>,
): { dispatched: boolean; payload: DeepLinkPayload | null } {
  const result = parseDeepLink(rawUrl);
  if (!result.ok) return { dispatched: false, payload: null };
  const payload = result.payload;
  switch (payload.kind) {
    case 'cli-authorize':
      if (router.onCliAuthorize !== undefined) {
        router.onCliAuthorize(payload.code, payload.state);
        return { dispatched: true, payload };
      }
      return { dispatched: false, payload };
    case 'session-open':
      if (router.onSessionOpen !== undefined) {
        router.onSessionOpen(payload.sessionId);
        return { dispatched: true, payload };
      }
      return { dispatched: false, payload };
    case 'recording-open':
      if (router.onRecordingOpen !== undefined) {
        router.onRecordingOpen(payload.recordingId);
        return { dispatched: true, payload };
      }
      return { dispatched: false, payload };
    case 'profile-import':
      if (router.onProfileImport !== undefined) {
        router.onProfileImport(payload.profileId);
        return { dispatched: true, payload };
      }
      return { dispatched: false, payload };
    case 'unknown':
      return { dispatched: false, payload };
  }
}
