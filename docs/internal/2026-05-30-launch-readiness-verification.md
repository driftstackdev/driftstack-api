# 2026-05-30 — launch-readiness verification (Agent 2)

A consolidated record of what was hardened + **verified** this session, and what
is gated on a founder decision. Intended as a single launch-planning artifact
so the scattered commit history doesn't have to be re-derived.

## Verified launch-ready (customer + operator surfaces)

- **Multi-archetype profile creation — functional end-to-end + guarded.**
  Verified the full contract, not just the UI: the dashboard selector + the GUI
  `FirstRunWizard` both send `archetype`; the server `CreateProfileRequestSchema`
  accepts it (`z.string().min(1).max(120).optional()`, pinned by
  `api-types-profiles-content-parity`); the route forwards it; the service stores
  it (`profiles-service.test.ts` asserts a non-default archetype persists). A
  customer's device choice is honored, not silently defaulted.
- **Archetype display is friendly platform-wide.** profiles / overview / customer
  sessions / admin sessions all render the registry label (not the raw slug);
  final scan empty. Marketing code-examples intentionally keep the raw slug
  (they're API-parameter values).
- **Operator tools — three broken surfaces fixed.** The admin Cost page (read a
  never-set token key → never loaded), the admin Audit-log "Errors only" filter
  (exact `=== 'error'` vs the real `error:<code>` format → matched nothing), and
  the account-detail Cost drill-in (sent the `acc_`-prefixed id to the strip-less
  cost route → 404 for every account). Root cause also fixed: the admin cost
  routes now lenient-strip `acc_` like every sibling admin `/:id` route.
- **Cross-layer contract classes audited clean** — token-key, result-format,
  id-format (`acc_` prefix), and session status-enum all verified consistent
  between the untyped `.astro` client scripts and the server contract.
- **Behavioral coverage** of every core customer page (overview / usage /
  audit-log / billing / select-tier) + every non-gated admin page (accounts /
  cost / overview / audit-log). Dashboard form a11y verified (labels ≥ controls
  on every form page).

## Gated on a founder decision (the next tier of value)

1. **Strategy** ("needs deep thinking first"): credit/usage pricing · own
   low-level C++ stealth · hosted-AI-under-Anthropic.
2. **Launch-archetype scope**: iphone16pro-in-code vs the iphone17 verdict; and
   **is iphone15pro a v1.0 SDK-supported archetype?** It's dashboard/GUI-selectable
   today but absent from the cross-SDK roster fixture (`archetype-roster.json`) —
   so the TS/Python/Go SDKs have no parity coverage for it. Yes → add it to the
   roster + all 3 SDK fixtures; no → leave the roster as-is.
3. **GUI wizard → registry derivation**: build-config is fine (no `tsc -b`
   blocker — verified); the only gate is a **UX label policy** — keep the wizard's
   marketing labels ("Most popular" / "Legacy") or switch to device labels.

## Known latent / deferred (non-blocking)

- `admin-usage.ts` is the one remaining non-stripping admin `/:id` endpoint, but
  has no admin-page caller (latent only). See
  `project_admin_cost_id_prefix_inconsistency` memory.
- The disabled trial-pack route stub + dead trial-pack email template can be
  removed in a later "retire trial-pack billing product" cleanup (grant no
  credit, send to no one).
