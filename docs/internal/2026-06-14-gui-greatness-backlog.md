# GUI "greatness" backlog — 6→9+ elevation (2026-06-14)

Founder rated the GUI ~6/10 and asked for "a lot more improvements." This is the ranked enhancement
backlog from a 5-lens ideation workflow (power-user · AI-chat depth · premium delight · overview/
data-viz · IA/flows), synthesized + filtered to buildable-now-first. Companion to
`2026-06-14-gui-console-build-plan.md` (the Console restyle plan). Execute top-down, wave by wave;
each a gate-green slice + batched into a Tauri rebuild.

⭐ Notable: the SDK already supports things the GUI never calls — `recipes.create({agent_session_id})`
(Save-as-recipe), `profiles.export/import/transfer`, agent-session `list()/get()` (chat history), the
SSE transcript stream, `usage.current()/series()` + `audit-log.list` (dashboard/feed). Lots of high
value is pure client glue.

## Tier 1 — Quick wins (S, buildable now)

- **Save-as-recipe** — AgentChatView button → `recipes.create({agent_session_id,label,description})`.
  The recipe library has ZERO GUI callers today; closes the chat→reusable-flow loop. (~30 lines.)
- **Action-grade ⌘K palette** — feed live profiles/sessions into `paletteActions` as verbs
  (Launch·<profile>, Clone, Stop session, Add proxy, Hand to AI, Switch accent). PaletteAction already
  supports run()/keywords; turns the menu into the app's control surface.
- **Saved Views / smart folders** — persist {search,statusFilter,sortBy,folderFilter,tag} presets to
  the local store (profile-templates pattern); quick-switch pills in ProfilesActionBar.
- **Richer toasts** — add a `success` tone (green check) + progress + an Undo action slot to lib/toasts.
- **Quota/cap + budget alert banners** — threshold cards from usage.quotas + account/me caps + agent
  token_budget_remaining, each with a one-click action.
- **Empty states with personality** — per-surface copy + wire EmptyState's action slot (Profiles →
  "Spin up your first iPhone 17", etc.).
- **Cross-view links** — make session/profile/recording ids clickable → route + reveal the related row.
- **Theme/accent switcher in chrome + ⌘⇧D** — accent-dot row in TitleBar/footer over the wired
  themeMode/themeAccent (buried in Settings today).
- **Keyboard shortcuts cheatsheet** (`?` / ⌘/) — self-contained overlay; advertises the new palette verbs.

## Tier 2 — High-impact (M, buildable now — the core uplift)

- **Live transcript streaming** — EventSource on GET /v1/agent-sessions/:id/transcript (?ds_token, Last-Event-ID) in useAgentChat → watch the agent think/act instead of a spinner. (Headline AI upgrade.)
- **Full bulk-action bar** — batch launch/stop/clone/delete/export over the existing selectedIds set (today it's only folder/tag). #1 heavy-operator need.
- **Command Center home view** (new default landing) — compose KPI tiles + session-health strip + activity feed + fleet board from existing data. The app has no overview today.
- **Conversation history sidebar** — agent-session list()/get() → a left rail of past chats (resume, status, cost, rename); re-open replays transcript + re-attaches SSE. (Chats are lost on New/restart today.)
- **Export / import / transfer** — wire profiles.export/import/transfer (SDK+server shipped, zero UI): per-row + bulk export-to-JSON, import dropzone, transfer-by-account dialog.
- **Live session-health strip** — status histogram + errored/stuck-in-creating callouts from sessions.list; deep-link to LiveSession.
- **AI cost & budget dashboard** — per-chat + account-wide over AgentUsage + token_budget + usage.series; pre-spend warnings.
- **Bulk proxy assignment** (single + round-robin) over profile-bindings.
- **Guided new-profile flow** — create → bind+test proxy → launch stepper.
- **KPI tiles w/ sparkline trends**, **activity feed from audit-log**, **keyboard-first list nav (j/k/L/S/X)**, **optimistic UI + undo**, **Notifications Center (unread badge)**, **"Hand off to AI" from a live session + active-sessions rail**, **drag-drop profile→folder org**, **per-profile history drawer**, **smooth view transitions + alive chrome**.

## Tier 3 — Ambitious / deeper / gated

- Multi-task queue (one prompt fanned across N profiles) · proxy fleet panel w/ geo probe→map · bulk
  create-from-template (clone-to-N) · surface fingerprint/archetype controls + consistency badge ·
  auto-record toggle · first-run product tour.
- **Gated:** watch-it-live LiveKit beside transcript · pair-mode takeover (mid-chat AI↔manual) ·
  rotating proxy pools (needs backend pool concept) · server-computed dashboard-summary endpoint.

## Build order (proposed)

Ship Tier-1 quick-wins in a batch (they're individually small + collectively transform the feel), then
the Command Center + bulk actions + live streaming + conversation history (the core uplift), then the
rest. Batch a Tauri rebuild after each meaningful group for founder review. Full raw ideation: workflow
`w2u77gq7j` output.
