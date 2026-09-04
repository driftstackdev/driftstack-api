# V-660 — Cloudflare setup for `status.driftstack.io` (founder ops action)

The status site (`apps/status-site/`) had no deploy pipeline, so
`status.driftstack.io` was NXDOMAIN — which broke the double-opt-in
status-subscription **confirm + unsubscribe email links** (they target
`status.driftstack.io/subscribe/confirm?token=` /
`…/unsubscribe?token=`, both 404 at the DNS layer).

## What's already done (automated, 2026-05-29)

- ✅ `apps/status-site/src/pages/subscribe/confirm.astro` +
  `unsubscribe.astro` built (the missing landing pages).
- ✅ Cloudflare **Pages project `driftstack-status`** created.
- ✅ Status site **deployed** — live at
  <https://driftstack-status.pages.dev> (index 200, subscribe pages 200).
- ✅ **Custom domain `status.driftstack.io` attached** to the project
  (status: `pending`, waiting only on the DNS record below).
- ✅ CI workflow `.github/workflows/deploy-status-site.yml` (auto-deploys
  on push to `apps/status-site/**`, mirrors the docs/admin pipelines).
- ✅ Repo variable `CLOUDFLARE_STATUS_SITE_PROJECT_NAME = driftstack-status`.
- ✅ Shared secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
  already present (used by the other site deploys).

## ✅ COMPLETE 2026-05-29 — CNAME added (founder), domain live + verified end-to-end (`status.driftstack.io/` 200; `/subscribe/confirm?token=` + `/unsubscribe?token=` serve + the `?token=` query survives the trailing-slash redirect). No further action needed. (Original remaining step, kept for the record:)

## The ONE remaining step (needs DNS write — the agent's token is `zone:read` only)

Add a single proxied CNAME in the `driftstack.io` zone:

| Type  | Name     | Target                        | Proxy                  |
| ----- | -------- | ----------------------------- | ---------------------- |
| CNAME | `status` | `driftstack-status.pages.dev` | Proxied (orange cloud) |

Two ways:

**Option A — Pages dashboard (auto-creates the DNS record):** CF dash →
**Workers & Pages** → `driftstack-status` → **Custom domains**. The
domain `status.driftstack.io` is already listed as pending — click
**Activate / retry** (or remove + re-add); since the zone is in this
account, CF offers to add the CNAME for you. Accept it.

**Option B — DNS tab:** CF dash → `driftstack.io` zone → **DNS** → add
the CNAME from the table above.

TLS (Google CA, already provisioning) finishes automatically once the
record resolves — usually under a minute.

Alternatively, grant the agent a token with `Zone → DNS → Edit` on the
`driftstack.io` zone and it will create the record + finish end-to-end.

## Verify

- <https://status.driftstack.io/> → 200.
- <https://status.driftstack.io/subscribe/confirm?token=…> renders the
  confirm pane (calls `GET /v1/status/subscribe/confirm`).
- No `PUBLIC_STATUS_PAGE_URL` change needed — prod is unset, so it falls
  back to the documented default `https://status.driftstack.io`, which
  now resolves. (Interim alternative, if you want the email links live
  before the CNAME: set `PUBLIC_STATUS_PAGE_URL=https://driftstack-status.pages.dev`
  on prod — but the CNAME is the clean end-state.)

## Rollback

CF Pages → `driftstack-status` → **Deployments** → roll back to a prior
deploy. Or remove the custom domain to revert to NXDOMAIN.
