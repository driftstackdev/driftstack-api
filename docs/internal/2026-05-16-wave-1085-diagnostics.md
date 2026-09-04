# Wave 1085+ launch-blocker diagnostics

Two of the 4 founder-reported issues are operator-action items I can
capture data for but can't fix code-side from this session. The
other two (signup validation + verify-email auto-verify) shipped
under commit `7f562c09`.

## Issue 1 — Google OAuth still fails with redirect_uri_mismatch

GitHub OAuth works on the same env wire → architecture is correct,
Google Console registration is the divergent variable.

### Diagnostic captured (prod, 2026-05-16)

`POST https://api.driftstack.dev/v1/auth/oauth-client/start` with
`{"provider":"google","redirect_to":"https://app.driftstack.io/"}`
returns an authorize URL with these parameters:

```
HOST:         accounts.google.com
CLIENT_ID:    552651380791-92pk82jvjdsav19pomhemjbostvc96hi.apps.googleusercontent.com
REDIRECT_URI: https://api.driftstack.dev/v1/auth/oauth/google/callback
SCOPE:        openid email profile
RESPONSE_TYPE: code
```

### What founder needs to check in Google Cloud Console

1. Open Google Cloud Console → APIs & Services → Credentials.
2. Find the OAuth 2.0 Client ID with this exact ID:
   `552651380791-92pk82jvjdsav19pomhemjbostvc96hi.apps.googleusercontent.com`
   (NB: the client_id env-wired on prod is THIS one; if there are
   multiple OAuth clients in the project, the one matching this ID
   is the one to inspect.)
3. Open the OAuth client's edit pane → "Authorized redirect URIs"
   section.
4. Verify the list contains **exactly**:
   `https://api.driftstack.dev/v1/auth/oauth/google/callback`

### Likely failure modes (most → least common)

- Trailing slash mismatch (Console has `…/callback/`; we send
  `…/callback`).
- HTTP vs HTTPS mismatch (Console has `http://…`).
- Subdomain mismatch (Console has `www.api.driftstack.dev` or
  `app.driftstack.io` instead of `api.driftstack.dev`).
- Wrong Client ID in Google Console — the one with the correct
  redirect URI is a DIFFERENT OAuth client than the one currently
  env-wired. In that case either (a) update the prod env's
  `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` to the
  correct one, or (b) add the URI to the currently-wired client.
- Multiple OAuth clients in the project and Google Console UI is
  showing the wrong one.

### What I can do once founder reports the Console state

- If Console URI matches what we send exactly → confirm via fresh
  smoke that nothing else changed; investigate Google-side caching
  or propagation.
- If Console URI differs → either update the env var (Tier-1
  authorized) OR document the required Console change.

GitHub works on the same env wire pattern → there is nothing wrong
with the code or the env-var format. This is purely a Google
Console-side configuration issue.

## Issue 4 — Trial pack + checkout endpoints 404

Root cause confirmed via prod logs:

```
{"level":"warn","component":"billing","msg":"BillingService NOT wired
(STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS + STRIPE_TRIAL_PACK_PRICE_ID
required); /v1/billing/* routes will not register"}
```

Prod `.env` state (`grep -E "^STRIPE_|^DRIFTSTACK_TIER_PRICE_IDS="`):

```
STRIPE_SECRET_KEY=<set>
STRIPE_PUBLISHABLE_KEY=<set>
# missing: STRIPE_TRIAL_PACK_PRICE_ID
# missing: DRIFTSTACK_TIER_PRICE_IDS
# missing: STRIPE_WEBHOOK_SECRET
```

### What founder needs to do

1. Create Stripe Products + Prices in the Stripe dashboard (LIVE
   mode for prod, TEST mode for staging). Per ADR-004 there are
   19 price IDs total — every subscription tier × {monthly, annual}
   plus the trial-pack one-time price. Naming convention:
   `driftstack_<tier>_<period>` (e.g. `driftstack_solo_monthly`).
2. Wire two env vars on `/opt/driftstack/api/.env`:
   - `STRIPE_TRIAL_PACK_PRICE_ID=price_…` (the one-time $2.99 price)
   - `DRIFTSTACK_TIER_PRICE_IDS='{"solo_manual":{"monthly":"price_…","annual":"price_…"},…}'`
     — JSON-stringified map. Full schema in
     `docs/deployment/env-vars.md` and `docs/operations/production-env-schema.md`.
3. Also wire `STRIPE_WEBHOOK_SECRET=whsec_…` (for inbound Stripe
   webhooks) once the webhook endpoint is configured in Stripe.
4. `systemctl restart driftstack-api` on prod (and staging).
5. Verify the boot log no longer shows "BillingService NOT wired"
   and that `curl -X POST https://api.driftstack.dev/v1/billing/trial-pack`
   returns 401 (auth-gated, route registered) instead of 404.

### What I can do once founder provides the price IDs

- SSH-write the env vars (never echoed/logged) — Tier-1 authorized.
- Restart the api service.
- Verify boot log + smoke.

### Same gap on staging

Likely. Worth verifying with the same boot-log grep before any
customer testing on staging.

## Issue 5 — AI chat agent layer scope expanded to v1.0

Acknowledged per founder verdict. Design doc lives at
`docs/internal/ai-chat-agent-layer-design.md` (~120h scope). When
greenlit, I'll begin Slice AI-1 (interface scaffolding + Anthropic
client encryption pattern) as a tracked arc parallel to other work.
Not started yet — waiting for the explicit "go" since this
materially changes the v1.0 launch surface.

## Issue 6 — Proactive enhancement ideas

Will surface in next batch per founder direction.

## Next steps (in priority order)

1. **You verify Google Cloud Console** for client_id
   `552651380791-92pk82jvjdsav19pomhemjbostvc96hi.apps.googleusercontent.com`
   has redirect URI
   `https://api.driftstack.dev/v1/auth/oauth/google/callback`
   exactly. Report back what's there.
2. **You create Stripe Products + Prices** in the Stripe dashboard
   per ADR-004 conventions. Share the two env-var strings
   (`STRIPE_TRIAL_PACK_PRICE_ID` + `DRIFTSTACK_TIER_PRICE_IDS`) in
   a secrets-safe channel (1Password / encrypted note) and I'll
   SSH-write + restart.
3. **You greenlight AI chat agent layer v1.0 inclusion** so I can
   start Slice AI-1.
4. **You browser-test signup** at https://app.driftstack.io/signup
   with a deliberately-invalid input (e.g. password "short") to
   confirm Issue 2 fix surfaces per-field message instead of
   "One or more fields failed validation."
5. **You browser-test verify-email link** by signing up, opening
   the verification email, clicking the link. Confirm Issue 3 fix:
   spinner shows "Verifying your account…" then redirects to
   /welcome with no code input visible.
