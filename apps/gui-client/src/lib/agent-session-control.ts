// Agent-session control transport for the simulator window.
//
// The SimulatorWindow is mounted under RecordingsProvider only — it has NO SDK
// client and NO SettingsProvider — so it can't use the SDK. This is a thin
// raw-fetch client modeled on lib/gui-input.ts, reading {apiKey, baseUrl} from
// the same Tauri store + Keychain via loadSettings(). It drives the
// agent-session control endpoints (mode / takeover / handback / message), which
// all require the `write` scope (account_owner satisfies it).

import { loadSettings } from './settings';

export type SessionMode = 'ai' | 'manual' | 'pair';

/** The slice of agent-session state the simulator control panel reads. */
export interface AgentSessionControlState {
  mode: SessionMode;
  /** pair_mode_state.kind (e.g. 'ai-driving' / 'human-driving'), or null. */
  pairKind: string | null;
}

export class AgentSessionControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** RFC 7807 type suffix — 'forbidden' (scope) / 'conflict' (state) /
     *  'not-found' / 'auth_missing' / 'unknown'. */
    readonly kind: string,
  ) {
    super(message);
    this.name = 'AgentSessionControlError';
  }
}

interface ApiSession {
  mode?: string;
  pair_mode_state?: { kind?: string } | null;
}

function isMode(v: unknown): v is SessionMode {
  return v === 'ai' || v === 'manual' || v === 'pair';
}

function pairKindOf(body: ApiSession): string | null {
  return body.pair_mode_state?.kind ?? null;
}

async function authedFetch(path: string, init: RequestInit): Promise<unknown> {
  const settings = await loadSettings();
  if (settings.apiKey === null || settings.apiKey.length === 0) {
    throw new AgentSessionControlError('API key not configured', 0, 'auth_missing');
  }
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let kind = 'unknown';
    try {
      const body = (await res.json()) as { detail?: string; title?: string; type?: string };
      detail = body.detail ?? body.title ?? detail;
      if (typeof body.type === 'string') kind = body.type.split('/').pop() ?? 'unknown';
    } catch {
      // Non-JSON error body — keep the HTTP-status defaults.
    }
    throw new AgentSessionControlError(detail, res.status, kind);
  }
  if (res.status === 204) return {};
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** GET the current mode + pair state (seed on mount, re-fetch on panel expand). */
export async function getAgentSession(id: string): Promise<AgentSessionControlState> {
  const body = (await authedFetch(`/v1/agent-sessions/${encodeURIComponent(id)}`, {
    method: 'GET',
  })) as ApiSession;
  return { mode: isMode(body.mode) ? body.mode : 'ai', pairKind: pairKindOf(body) };
}

/** POST a new control mode; returns the resulting mode + pair state. */
export async function setSessionMode(
  id: string,
  mode: SessionMode,
): Promise<AgentSessionControlState> {
  const body = (await authedFetch(`/v1/agent-sessions/${encodeURIComponent(id)}/mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })) as ApiSession;
  return { mode: isMode(body.mode) ? body.mode : mode, pairKind: pairKindOf(body) };
}

/** Human grabs control in pair mode. Returns the new pair_mode_state.kind.
 *  client_id is a stable per-window id so the takeover lock is coherent. */
export async function takeoverSession(id: string, clientId: string): Promise<string | null> {
  const body = (await authedFetch(`/v1/agent-sessions/${encodeURIComponent(id)}/takeover`, {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId }),
  })) as ApiSession;
  return pairKindOf(body);
}

/** Return control to the agent in pair mode. Returns the new pair kind. */
export async function handbackSession(id: string): Promise<string | null> {
  const body = (await authedFetch(`/v1/agent-sessions/${encodeURIComponent(id)}/handback`, {
    method: 'POST',
    body: JSON.stringify({}),
  })) as ApiSession;
  return pairKindOf(body);
}

/** Send a free-text instruction to the agent (ai/pair modes). */
export async function sendAgentMessage(id: string, userMessage: string): Promise<void> {
  await authedFetch(`/v1/agent-sessions/${encodeURIComponent(id)}/message`, {
    method: 'POST',
    body: JSON.stringify({ user_message: userMessage }),
  });
}
