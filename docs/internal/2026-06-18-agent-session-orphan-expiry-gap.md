# Agent-session orphan / expiry gap — ROOT of "stale sessions show open" (founder 2026-06-18)

## The bug (founder-reported)

"We don't keep proper track of sessions that are actually opened/started — always
says open session even on long-expired sessions that failed."

## Root cause (verified in code)

Agent sessions (`agent_sessions`, `status` = `active|paused|closed`) transition to
`closed` **only** via:

- `closeWithReason(id, 'customer-closed')` — explicit `DELETE /v1/agent-sessions/:id`
  (`routes/agent-sessions.ts:1880`).
- `closeWithReason(id, 'budget-exhausted')` — the agent runtime when the token
  budget runs out (`services/agent-runtime.ts:347`).

There is **NO time-based reaper** (the only sweepers are `agent-pair-mode-heartbeat-sweep`
and `profile-trash.purge` — neither closes sessions) and **NO worker-disconnect
cleanup** (`fleet-control-registry` closes the _connection_ on disconnect, not the
node's assigned sessions — and the server does not persist a session→node mapping).

So an agent session lingers `active` **forever** when:

- the assigned worker **crashes/disconnects** without a clean close (the founder's
  "failed" sessions), or
- the customer **abandons** it (closes the GUI window without DELETE — common), or
- it's **idle** (no agent turns → budget never exhausts).

## Impact

1. **Founder-visible:** stale `active` sessions show "Open session" (GUI) — the GUI
   `boundSession` fix (2026-06-18) self-heals `closed`/gone sessions to idle, but
   these are genuinely still `active`, so they still read as running.
2. **Cap consumption:** stale `active` sessions count against `concurrent_session_cap`
   → a customer can hit "cap reached" with zero real sessions running.
3. **Worker slots / dispatch** may be held by phantom sessions.

## Fix options (needs founder + A1 scoping — DO NOT blind-auto-close)

- **(A) Worker reports session-end (best, precise — A1/harness, Rule G):** when the
  worker's browser closes/crashes, it reports completion → server `closeWithReason`.
  Event-driven, no time-cap guessing. Touches the fork/harness (A1).
- **(B) Worker-disconnect cleanup (server, precise):** persist a session→node mapping
  on dispatch; on fleet-node disconnect, `closeWithReason(reason='worker-disconnected')`
  for that node's `active` sessions. Needs the new mapping column/table.
- **(C) Time-based reaper (server, simple, needs a policy cap):** a daily/N-min
  sweeper that closes `active` sessions older than a wall-clock cap. SAFE only with a
  generous cap (e.g. 6–24h — no real interactive session runs that long); a tight cap
  risks false-closing a legitimate long agent run. The cap is a **policy decision**
  (max session lifetime) the founder should set.

## Recommendation

Ship **(B)** (precise, server-only, safe) as the primary fix + **(C)** with a generous
cap (e.g. 12h) as a backstop for sessions whose node never formally disconnected.
Coordinate **(A)** with A1 for the clean-close path. Held for founder/A1 input rather
than blind-auto-closing while the founder is away (could disrupt a live session).

## Current mitigation (shipped 2026-06-18)

GUI `boundSession` (`ProfilesView`) self-heals `closed`/gone agent bindings to idle
(commit 38a42d19). This covers customer-closed + budget-exhausted; it does NOT cover
orphaned-`active` sessions (the gap above).
