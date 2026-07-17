// The per-session GUI control key authorizes session reads and control for at
// most the API-issued lifetime. It must never be retained in WebView storage or
// the OS credential store. Rust consumes the owner-only launch handoff before
// creating/updating the WebView and keeps the authoritative value only in its
// bounded, zeroizing process-memory vault. JavaScript receives a non-secret
// generation and may only load or delete that exact native entry.

const LEGACY_GCK_STORE_PREFIX = 'ds-gck-';
const protectedOperationTails = new Map<string, Promise<unknown>>();

function isSafeControlSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= 64 && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

function isSafeControlGeneration(generation: number): boolean {
  return Number.isSafeInteger(generation) && generation > 0;
}

function operationIdentity(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`;
}

function serializeProtectedOperation<T>(
  sessionId: string,
  generation: number,
  operation: () => Promise<T>,
): Promise<T> {
  const identity = operationIdentity(sessionId, generation);
  const previous = protectedOperationTails.get(identity) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  protectedOperationTails.set(identity, current);
  return current.finally(() => {
    if (protectedOperationTails.get(identity) === current) {
      protectedOperationTails.delete(identity);
    }
  });
}

/**
 * Remove historical plaintext WebView entries without reading or importing
 * their values. Old OS-Keychain gui_control items are intentionally untouched:
 * enumerating or deleting them can itself trigger the prompt being retired.
 */
export function scrubLegacyControlKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name !== null && name.startsWith(LEGACY_GCK_STORE_PREFIX)) keys.push(name);
    }
    for (const name of keys) localStorage.removeItem(name);
  } catch {
    // Storage may be unavailable; never create a fallback or delay native load.
  }
}

export async function loadProtectedControlKey(
  sessionId: string,
  generation: number,
): Promise<string> {
  if (!isSafeControlSessionId(sessionId) || !isSafeControlGeneration(generation)) return '';
  return serializeProtectedOperation(sessionId, generation, async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const value = await invoke<unknown>('simulator_control_key_load', { sessionId, generation });
    return typeof value === 'string' ? value : '';
  });
}

/** Delete only the exact native generation owned by this WebView session. */
export async function clearPersistedControlKey(
  sessionId: string,
  generation: number,
): Promise<void> {
  scrubLegacyControlKeys();
  if (!isSafeControlSessionId(sessionId) || !isSafeControlGeneration(generation)) return;
  return serializeProtectedOperation(sessionId, generation, async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('simulator_control_key_delete', { sessionId, generation });
  });
}

/** Retain only non-secret routing fields after the initial query is parsed.
 * `null` is the deliberate in-app/account path. Any native handoff, including
 * credential-absent `cg=0`, must preserve an explicit generation marker so a
 * reload cannot reinterpret fail-closed Simulator control as account auth. */
export function safeSimulatorSearch(sessionId: string, generation: number | null): string {
  const params = new URLSearchParams({ window: 'simulator' });
  if (isSafeControlSessionId(sessionId)) params.set('session', sessionId);
  if (generation !== null) {
    params.set('cg', isSafeControlGeneration(generation) ? String(generation) : '0');
  }
  return `?${params.toString()}`;
}
