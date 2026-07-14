// The per-session GUI control key authorizes session reads, control, messages,
// cookies, files, and termination for up to 24 hours. Keep it out of ordinary
// WebView storage: each session gets a dedicated OS credential-store item.
//
// Older builds wrote `ds-gck-*` values to localStorage. Migration removes every
// legacy value synchronously before awaiting the credential store. If Keychain
// is locked, the current process may retain the returned value in memory for
// this launch, but plaintext is never written back to disk.

const CONTROL_SECRET_PREFIX = 'gui_control:';
const LEGACY_GCK_STORE_PREFIX = 'ds-gck-';
const protectedControlKeys = new Map<string, string>();
const protectedLoadFailures = new Map<string, { message: string; retryAfter: number }>();
const PROTECTED_LOAD_RETRY_MS = 30_000;

function isSafeControlSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= 64 && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

function controlSecretName(sessionId: string): string {
  return `${CONTROL_SECRET_PREFIX}${sessionId}`;
}

function takeLegacyControlKeys(): Map<string, string> {
  const found = new Map<string, string>();
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name !== null && name.startsWith(LEGACY_GCK_STORE_PREFIX)) keys.push(name);
    }
    for (const name of keys) {
      const sessionId = name.slice(LEGACY_GCK_STORE_PREFIX.length);
      const value = localStorage.getItem(name);
      localStorage.removeItem(name);
      if (isSafeControlSessionId(sessionId) && value !== null && value.length > 0) {
        found.set(sessionId, value);
      }
    }
  } catch {
    // Storage access failed; no disk fallback is created.
  }
  return found;
}

export async function loadProtectedControlKey(sessionId: string): Promise<string> {
  if (!isSafeControlSessionId(sessionId)) return '';
  const cached = protectedControlKeys.get(sessionId);
  if (cached !== undefined) return cached;

  const priorFailure = protectedLoadFailures.get(sessionId);
  if (priorFailure !== undefined && Date.now() < priorFailure.retryAfter) {
    throw new Error(priorFailure.message);
  }

  const { invoke } = await import('@tauri-apps/api/core');
  let value: unknown;
  try {
    value = await invoke<unknown>('secret_load', { key: controlSecretName(sessionId) });
  } catch (error) {
    protectedLoadFailures.set(sessionId, {
      message: error instanceof Error ? error.message : 'Protected session credential unavailable.',
      retryAfter: Date.now() + PROTECTED_LOAD_RETRY_MS,
    });
    throw error;
  }
  protectedLoadFailures.delete(sessionId);
  const key = typeof value === 'string' ? value : '';
  if (key !== '') protectedControlKeys.set(sessionId, key);
  return key;
}

export async function persistControlKey(sessionId: string, key: string): Promise<void> {
  if (!isSafeControlSessionId(sessionId) || key === '') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('secret_save', { key: controlSecretName(sessionId), value: key });
  protectedControlKeys.set(sessionId, key);
  protectedLoadFailures.delete(sessionId);
}

export async function migrateLegacyControlKeys(
  activeSessionId: string,
): Promise<Map<string, string>> {
  const legacy = takeLegacyControlKeys();
  // Historical builds accumulated one plaintext entry per session. Purge all
  // of them, but migrate only the session actually being reopened; copying
  // dozens of expired credentials into Keychain would create a new stale-secret
  // inventory. A sessionless upgrade therefore scrubs plaintext with zero new
  // protected entries.
  const activeValue = legacy.get(activeSessionId);
  if (activeValue === undefined) return legacy;
  try {
    const protectedValue = await loadProtectedControlKey(activeSessionId);
    if (protectedValue === '') await persistControlKey(activeSessionId, activeValue);
  } catch {
    // Plaintext was already purged. The current session may use the returned
    // map in memory for this launch; stale sessions require a fresh reopen.
  }
  return legacy;
}

/** Drop protected + legacy copies before explicitly ending the session. */
export async function clearPersistedControlKey(sessionId: string): Promise<void> {
  if (!isSafeControlSessionId(sessionId)) return;
  protectedControlKeys.delete(sessionId);
  protectedLoadFailures.delete(sessionId);
  try {
    localStorage.removeItem(LEGACY_GCK_STORE_PREFIX + sessionId);
  } catch {
    // Nothing else to clear on disk.
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('secret_delete', { key: controlSecretName(sessionId) });
}

/** Retain only the non-secret routing fields after the initial query is parsed. */
export function safeSimulatorSearch(sessionId: string): string {
  const params = new URLSearchParams({ window: 'simulator' });
  if (isSafeControlSessionId(sessionId)) params.set('session', sessionId);
  return `?${params.toString()}`;
}
