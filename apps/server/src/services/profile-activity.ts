// P-23 — project a profile's recent navigation out of agent session transcripts.
//
// ⛔ This is ACCOUNT ACTIVITY, not "browsing history". Ledger decision D-1 keeps
// the server-side transcript out of the profile's "Clear history" action (that
// clears the profile's open tabs on the device and nothing else), so a customer
// who clears history and then opens this view still sees these rows. The name
// is part of the contract; every caller — route, SDKs, docs, GUI — says
// "activity" for that reason, and the GUI must never label it "history".
//
// Shared by BOTH AgentSessionsRepo implementations (Drizzle and in-memory) so the
// projection cannot drift between the store the tests use and the store
// production uses — the class of defect the tenant-boundary sweep (P-38) found
// when two repos each carried their own copy of a predicate.

import type { TranscriptEntry } from './agent-decomposer.js';

export interface ProfileActivityEntry {
  /** ISO-8601 time the navigation was planned (the transcript entry's `at`). */
  at: string;
  /** The destination URL as the agent planned it — path and query included. */
  url: string;
  /** The agent session the navigation belonged to. */
  agentSessionId: string;
}

export interface ProfileActivity {
  /** Most recent first, bounded by `entryLimit`. */
  entries: ProfileActivityEntry[];
  /** How many sessions were actually read (≤ `sessionLimit`). */
  sessionsScanned: number;
  /** True when a bound was hit: more sessions existed, or more navigations. */
  truncated: boolean;
}

/** The server's fixed bounds. No query parameters: a fixed cap keeps the route
 *  off the querystring-validation and published-bound rosters, and 100 sessions
 *  × their navigations is far more than any panel renders. */
export const PROFILE_ACTIVITY_SESSION_LIMIT = 100;
export const PROFILE_ACTIVITY_ENTRY_LIMIT = 500;

/**
 * `sessions` must be the profile's sessions MOST RECENT FIRST, and may carry one
 * more than `sessionLimit` so "more sessions exist" is detectable without a
 * second count query. Only `plan-executed` entries carry `intents`; a navigate
 * intent's `url` is unconstrained by schema (path and query included), which is
 * exactly why this view exists and exactly why it is labelled activity.
 */
export function projectProfileActivity(
  sessions: ReadonlyArray<{ id: string; transcript: ReadonlyArray<TranscriptEntry> }>,
  opts: { sessionLimit: number; entryLimit: number },
): ProfileActivity {
  const moreSessions = sessions.length > opts.sessionLimit;
  const scanned = moreSessions ? sessions.slice(0, opts.sessionLimit) : sessions;
  const entries: ProfileActivityEntry[] = [];
  for (const session of scanned) {
    for (const entry of session.transcript) {
      if (entry.intents === undefined) continue;
      for (const intent of entry.intents) {
        if (intent.kind !== 'navigate') continue;
        entries.push({ at: entry.at, url: intent.url, agentSessionId: session.id });
      }
    }
  }
  // Most recent first across sessions. Entries carry their own timestamps, so a
  // session that ran longer than a newer one still interleaves correctly.
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const moreEntries = entries.length > opts.entryLimit;
  return {
    entries: moreEntries ? entries.slice(0, opts.entryLimit) : entries,
    sessionsScanned: scanned.length,
    truncated: moreSessions || moreEntries,
  };
}
