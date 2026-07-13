// GUI control plane — thin client for `/v1/sessions/:id/gui-input`.
//
// Per L-001 (docs/locked-decisions.md), coordinate-level primitives
// don't appear on the customer SDK surface. The self-hosted GUI talks
// to a separate, scope-gated endpoint via this helper. The wire shape
// matches the server's `GUIInputActionSchema` exactly; we don't share
// types because the server schema is internal-only.
//
// Auth: requires the API key to carry the `gui_control` scope.
// Mutates the session via the same WebKit driver as `/interact` does,
// just on the gui-control branch.

import { fetchWithDeadline } from './fetch-with-deadline';
import type { DriftstackSettings } from './settings';

export type GUIInputAction =
  | { kind: 'tap_at'; x: number; y: number }
  | { kind: 'type_focused'; text: string; delay_ms?: number };

export interface GUIInputResponse {
  ok: true;
  duration_ms: number;
}

export class GUIInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string,
  ) {
    super(message);
    this.name = 'GUIInputError';
  }
}

export async function sendGUIInput(
  settings: DriftstackSettings,
  sessionId: string,
  action: GUIInputAction,
): Promise<GUIInputResponse> {
  if (settings.apiKey === null || settings.apiKey.length === 0) {
    throw new GUIInputError('API key not configured', 0, 'auth_missing');
  }
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const res = await fetchWithDeadline(
    `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/gui-input`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let kind = 'unknown';
    try {
      const body = (await res.json()) as { detail?: string; type?: string; title?: string };
      detail = body.detail ?? body.title ?? detail;
      // Server emits RFC 7807 `type` URIs like "https://errors.driftstack.dev/forbidden".
      if (typeof body.type === 'string') kind = body.type.split('/').pop() ?? 'unknown';
    } catch {
      // Body wasn't JSON; keep the HTTP-status fallback.
    }
    throw new GUIInputError(detail, res.status, kind);
  }
  return (await res.json()) as GUIInputResponse;
}
