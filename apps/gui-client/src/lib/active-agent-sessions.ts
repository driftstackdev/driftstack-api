// active-agent-sessions — fold profile-launched AGENT sessions into the
// GUI's "how many phones are running" surfaces.
//
// Background (consistency audit #5): launching a profile calls
// client.agentSessions.create() and produces an `agt_<uuid>` AGENT session
// with NO linked driver row. But every "sessions" surface — SessionsView,
// CommandCenterView session-health, and the account's
// `concurrent_session_active` counter (Sidebar / Command Center / Sessions
// header) — reads the DRIVER `sessions` list/count only. So a user launches a
// live iPhone from a profile and every dashboard claims zero active sessions.
//
// The server's `concurrent_session_active` is driver-only (countActiveSessions
// over the `sessions` table) and can't be changed from the GUI, so the GUI
// folds the active agent count in client-side. Driver (`ses_`) and agent
// (`agt_`) sessions are disjoint id-spaces — a profile launch creates ONLY an
// agent session, the Sessions "New session" button creates ONLY a driver
// session — so summing the two counts never double-counts.

import type { DriftstackClient } from './client';

/**
 * An agent session is "active" (consuming a concurrent slot) exactly when its
 * status is `'active'`. `'paused'` and `'closed'` do not. Pure + exported so
 * the rollup is unit-tested independently of the fetch.
 */
export function countActiveAgentSessions(sessions: ReadonlyArray<{ status: string }>): number {
  let n = 0;
  for (const s of sessions) {
    if (s.status === 'active') n += 1;
  }
  return n;
}

/**
 * Fetch the count of the account's ACTIVE agent sessions (best-effort).
 *
 * Returns `null` — meaning "unknown, don't adjust the displayed count" — when
 * the client is absent, the agent-session route isn't wired on this deployment
 * (the SDK 503s / the method is missing), or the fetch fails. A `null` must
 * never be treated as zero: the caller keeps showing the server's driver-only
 * count rather than wrongly subtracting running phones.
 */
export async function fetchActiveAgentSessionCount(
  client: DriftstackClient | null,
): Promise<number | null> {
  if (!client) return null;
  // `agentSessions` is a typed resource on the real SDK client, but a partial
  // client (older deployment / test mock) may not carry it — guard the access
  // at runtime so a missing resource degrades to null, not a throw.
  const agentSessions = client.agentSessions as DriftstackClient['agentSessions'] | undefined;
  if (agentSessions === undefined || typeof agentSessions.list !== 'function') return null;
  try {
    const page = await agentSessions.list();
    return countActiveAgentSessions(page.data);
  } catch {
    return null;
  }
}
