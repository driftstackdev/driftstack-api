// App version — the REAL build version, not a hardcoded literal.
//
// The title bar showed a hardcoded "v0.0.1" (P2 #11) which would silently lie the
// moment the app version bumped. The source of truth is the Tauri app version
// (tauri.conf.json `version`, read at runtime via @tauri-apps/api/app `getVersion`).
// Outside Tauri (browser preview / tests) we fall back to the build-time
// VITE_APP_VERSION, then a final literal so the slot is never blank.

import { useEffect, useState } from 'react';

/** Build-time fallback (when not running under Tauri). Mirrors lib/telemetry's
 *  APP_VERSION resolution so the two agree. */
export const FALLBACK_APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.0.1';

/** Resolve the real app version: the Tauri runtime version when available, else
 *  the build-time fallback. Never throws — a failed/absent Tauri call degrades to
 *  the fallback. */
export async function resolveAppVersion(): Promise<string> {
  try {
    // Dynamic import so a browser/test build (no Tauri runtime) doesn't hard-depend
    // on the module resolving at load time.
    const { getVersion } = await import('@tauri-apps/api/app');
    const v = await getVersion();
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    // Not under Tauri / call failed — use the fallback below.
  }
  return FALLBACK_APP_VERSION;
}

/** Hook: the real app version, seeded with the build-time fallback so the UI never
 *  flashes blank, then replaced with the Tauri runtime version once resolved. */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(FALLBACK_APP_VERSION);
  useEffect(() => {
    let cancelled = false;
    void resolveAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
