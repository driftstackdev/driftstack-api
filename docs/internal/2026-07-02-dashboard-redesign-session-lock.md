# Dashboard-redesign session coordination (2026-07-02)

**An interactive Claude session is actively driving the customer-dashboard
redesign** (founder-approved plan: slices 1–5; slices 1, 2, and 3.1 are
committed — see `feat(dashboard): Fleet v2 …` commits). If you are another
agent session working this checkout:

- **Do not edit** `apps/customer-dashboard/**`, its test trees
  (`apps/customer-dashboard/tests/**`, the `apps/server/tests/unit/
*dashboard*`/`*customer-dashboard*` parity files), or
  `docs/internal/visual-demos/dashboard-shell-2026-07-02/**` until this
  note is removed.
- **Avoid running root `npm test` / workspace builds concurrently** with
  the driving session's gates — the pretest rebuilds every `dist/` and
  races the jsdom page tests (observed 2026-07-02 18:47: a concurrent
  rebuild caused 8 transient ENOENT test failures in an otherwise green
  gate).
- Working-tree pickups: if you find uncommitted dashboard changes, they
  belong to the driving session mid-slice — leave them unstaged. (The
  2026-07-02 18:48 pickup of slice 3.1 was verified correct after the
  fact, but only by luck of timing.)

Non-dashboard work (gui-client, server features, packages) is unaffected —
just coordinate gate timing. This note is removed when the redesign lands.
