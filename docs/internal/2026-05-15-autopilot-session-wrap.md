# Autopilot session wrap (2026-05-15)

Complement to `2026-05-15-prod-wire-up-batch-report.md`. Captures what
the long-running autopilot session left in a shippable / partially-
shippable state and exactly what's needed to take each remaining task
across the finish line. Read this when starting the next shift.

## What's shippable today

**Pure code-side, no operator action required:**

- 13 route-level cross-source-invariant drift-guards (W1039–W1051).
- 1 lib-level drift-guard (W1052 `lib/livekit-token`).
- 1 large-file cross-cutting drift-guard (W1053 `routes/admin-accounts`).
- 1 service-method parity pin (`findOwnedSessionLite`).
- 3 new integration test suites:
  - `tests/integration/sessions-livekit-token.test.ts` (7 cases)
  - `tests/integration/webhooks-nowpayments.test.ts` (6 cases)
  - magic-link + resend-verification rate-limit tests (added to
    `tests/integration/auth-ip-rate-limit.test.ts`)
- 3 parity-test alignment fixes for the W1042-era `magicLink` IP-
  limit addition.
- 1 latent route-bug fix (V-531.B `ses_` prefix + prefix-strip-before-
  findSession). Both would have 404'd every real session in prod.

**Tracks that ship as soon as the operator wires env:**

- A — Postmark: write `POSTMARK_API_TOKEN`/`FROM`/`REPLY_TO` to
  `/etc/driftstack/api.env`, restart, run `scripts/smoke-postmark.mjs`.
- B — NowPayments: write `NOWPAYMENTS_API_KEY`/`IPN_SECRET`/`PUBLIC_KEY`,
  restart, trigger an IPN test from the merchant dashboard.
- E — LiveKit: write `LIVEKIT_API_KEY`/`API_SECRET`/`WS_URL`, restart,
  run `scripts/smoke-livekit.mjs --session-id sess_demo --role publisher`.

**Tracks that are end-to-end live:**

- D — Sentry: 6 per-service projects live, DSN secrets set, deploys
  re-triggered.
- H — #187 + #190: resend-verification (server-side rate-limited +
  dashboard re-trigger button) + magic-link request (server-side IP
  cap + new `/auth/magic-link-request` page + login affordance).

## What's NOT shippable from this position

Three categories — each needs human intervention.

### 1. Founder verdict needed

**Track C — OAuth Google + GitHub social login (V-667 client side).**
Greenfield slice (~6–8h). The credentials pasted into the directive
are ready; the work itself is:

- Outbound OAuth flow to accounts.google.com / github.com/login.
- Identity-provider callback handler.
- Account-linking semantics. **This is the verdict point.** Edge
  cases that bite when implemented half-finished:
  - Existing-email-different-IDP collision (do we auto-link, prompt,
    or reject?).
  - IDP-revocation handling (do we keep the session, force re-auth,
    or revoke immediately?).
  - Avatar / name sync (one-shot at link, refresh on every login,
    or read-only-display from internal?).
- DB table `account_identity_links` (provider + provider_sub +
  account_id + linked_at, unique-index per provider+sub).
- UI affordance on signup + login screens.

The existing V-667.B OAuth-SERVER work is unrelated and complete.
Drift-guard at W1045 + integration tests at `tests/integration/oauth-*`
cover it.

### 2. Operator SSH needed

**Track F — V-278.K Neon prod/staging split + V-278.L Upstash split.**
The high-risk single step is the `DATABASE_URL` rotation. Founder
should do this hands-on. Estimated ~3h operator time.

**Tracks A/B/E env wiring** also need SSH but each is ~10 min.

### 3. Track E frontend (`livekit-client` dep)

The customer-side LiveKit subscriber probe. The server-side is end-
to-end live; the GUI client + customer dashboard continue using HTTP
polling until this slice lands. Adds `livekit-client` as a dep
(transitive WebRTC + protobuf footprint — moderate).

Surface:

- `apps/gui-client/src/views/LiveSessionView.tsx` — useEffect that
  posts `/v1/sessions/:id/livekit-token` with `{ role: 'subscriber' }`.
  - 200 → open `new Room()`, connect with returned ws_url + token,
    render subscribed video track to a `<video>` element.
  - 404 → existing HTTP polling path (no behavior change for
    pre-env-wire-up / LiveKit-outage).
- Smoke: open a live session against a Mac-mini with the publisher
  side wired; confirm first frame paints within ~500ms.

Estimated ~1h focused.

## Drift-guard coverage matrix (post-session)

| Layer    | Coverage status                                                    |
| -------- | ------------------------------------------------------------------ |
| Routes   | Every customer-facing + admin route file has a parity/drift-guard. |
| Libs     | All major libs covered, including the new `livekit-token`.         |
| Services | `findOwnedSessionLite` covered; existing W404.C continues to pin   |
|          | everything else in `services/sessions.ts`.                         |

The 15-row table from `2026-05-15-prod-wire-up-batch-report.md` is the
canonical inventory for this session's drift-guard additions.

## Operator-side checklist (the next shift's punch list)

1. Wire 3 Postmark env vars + restart + smoke (Track A) — 10 min.
2. Wire 3 NowPayments env vars + restart + smoke from merchant dashboard
   (Track B) — 25 min.
3. Wire 3 LiveKit env vars + restart + smoke via `scripts/smoke-
livekit.mjs` (Track E env-side) — 10 min.
4. Rotate `SENTRY_AUTH_TOKEN` since it was pasted into a chat transcript
   (defensive hygiene — token only used by the
   `sentry-create-per-service-projects.mjs` script).
5. (Optional, when ready) start Track E frontend slice — 1h.
6. (Optional, after founder verdict) start Track C — 6–8h.
7. (When operator has SSH time) Track F prod/staging split — 3h.

## Test-suite state (end of session)

- `npm test` clean: **1806 test files / 18105 passed / 143 skipped /
  0 failed**.
- `tsc --build` + `tsc --noEmit -p tsconfig.test.json` clean.
- Pre-push hook gate clean on every commit pushed this session
  (see `git log origin/main` for the per-commit cadence).
