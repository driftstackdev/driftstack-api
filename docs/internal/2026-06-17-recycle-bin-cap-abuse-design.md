# Recycle-bin vs profile-cap abuse — design + recommendation

Status: DESIGN (founder-flagged 2026-06-17: "recycle bin can be abused by
low-profile-limit users to keep storing profiles"). Implement as a focused slice
(sensitive — it's the profile-cap boundary + involves a hard-delete path).

## The abuse (verified in code)

`profiles-repo.insertWithLimit` counts only **non-deleted** rows against the
per-tier cap (`notDeleted = isNull(deletedAt)`, profiles-repo.ts:100). Soft-delete
(`delete()`) just sets `deletedAt`; the row + its DEK + sealed blob survive until
the 30-day purge job (`purgeTrashedBefore`). So a free-tier user (cap = 1) can:
trash their profile (no longer counts) → create another → trash it → … →
**accumulate unbounded recoverable profiles** while always ≤ cap live. The cap is
circumvented; storage grows without limit.

There is **no user-facing manual purge** today (only GET /v1/profiles/trash +
POST /:id/restore; the only hard-delete is the 30-day background job). That gap
matters for the fix (below).

## Options weighed

1. **Trash counts toward the cap** (live + trashed ≤ cap). Fully abuse-proof;
   non-destructive (blocks _creation_, deletes nothing). Cost: a user at total-cap
   can't create until they restore or purge — and with no manual purge they'd be
   stuck for 30 days. ⟹ REQUIRES a manual-purge companion.
2. **Trash-size cap (FIFO)** — trash holds ≤ cap items; trashing when full
   hard-purges the oldest. Bounds total ≤ 2×cap; preserves "delete to make room"
   - undo. Cost: it auto-hard-deletes the oldest-over-cap trashed (silent data
     loss) — riskier, needs care + tests.
3. **Short retention for over-cap accounts** — keep cap = live-only but purge
   trashed in e.g. 48h when the account is at its live cap. Gentle; but a real
   accidental delete is gone in 48h, and it's a time-based heuristic.

## ⭐ Recommendation: Option 1 (trash counts toward the cap) + manual purge

It's the intuitive model ("your trash counts toward your limit — empty it to
make room"), fully abuse-proof, and **non-destructive** (no surprise hard-delete;
the user explicitly frees space). Slice:

1. **Server cap-count** — `insertWithLimit`'s cap check counts ALL non-purged rows
   for the account (live + trashed), not just `notDeleted`. (The _read_/list paths
   stay `notDeleted` — trashed still hidden from the live grid.) One focused change
   under the existing account-row lock; non-destructive.
2. **Manual purge endpoint** — `DELETE /v1/profiles/:id/purge` (or `?permanent=1`):
   owner-scoped, trashed-only, hard-deletes the row (reuse the purge repo path,
   scoped to one id). Audit `profile.purged`. This is the user-initiated free-space
   action the cap-count change needs.
3. **GUI** — in the Trash view, a "Delete permanently" button per row (confirm:
   "permanently deletes — cannot be restored") + surface that trashed profiles
   count toward the limit ("empty trash to free space"); the cap counter already
   shown on the hub can note live+trashed.
4. **Keep** the 30-day auto-purge as the backstop.

Net: total stored profiles ≤ cap (abuse closed); recycle bin still does undo
(restore within your cap headroom) + the user can free space instantly via purge.
SDK: add `purge` to the profiles resource lockstep (TS/Go/Python) if the GUI uses
the SDK (it uses the client) — verify before widening.

## Safety / test bar (the cap boundary)

- Cap-count counts live + trashed; over-cap create → TierLimitError (existing path).
- Purge is owner-scoped + trashed-only (can't purge a live or another account's profile).
- Restore still works within cap headroom; name-conflict path unchanged.
- Tests: trash-then-create blocked at cap; purge frees a slot → create succeeds;
  cross-account purge rejected; live profile can't be purged.
