# V-278 final state — control plane v1.0 LIVE

> **⚠ V-870 — this is a CHECKPOINT, and parts of it have expired.**
>
> Everything below describes state as of the checkpoint date. It is read as
> current — V-869 used its sub-processor map to establish what production runs
> on — so the items that have since changed are named here rather than left for
> a reader to trip over. The tables themselves are NOT rewritten: a
> point-in-time record that gets edited to match today stops being a record.
>
> - **F-003 OAuth is built.** Listed below as deferred at "~6h" and as blocked on
>   registering OAuth apps. `apps/server/src/routes/auth-oauth-client.ts` ships
>   the start / callback / confirm-merge flow, `oauth-client-providers.ts` carries
>   Google and GitHub, and `oauth_client` is one of the activation flags. The
>   ESTIMATE is what expired. The credential dependency is a separate question
>   and this note does not claim it is satisfied.
> - **NowPayments was chosen.** The blocked row says "no provider chosen yet".
>   `apps/server/src/lib/nowpayments-signing.ts` verifies IPN signatures, and the
>   crypto rail ships eight customer-facing routes.
> - **V-278.L still stands.** `scripts/v278l-upstash-split-cutover.sh` exists, but
>   its own header says prod and staging share one Redis instance today — the
>   script is written, not necessarily run. Checked and left alone deliberately,
>   because the presence of a cutover script is not evidence of a cutover.

**Checkpoint date:** 2026-05-09
**HEAD at checkpoint:** `632a5f2`
**TLS posture:** Cloudflare Full (strict), TLS 1.3 customer-edge ↔ Cloudflare ↔ origin

## Live URLs (6/6 HTTP 200, Rule L empirical proof)

| URL                                   | HTTP | Served by                                                      |
| ------------------------------------- | ---- | -------------------------------------------------------------- |
| https://driftstack.dev/               | 200  | Cloudflare Pages → driftstack-marketing                        |
| https://www.driftstack.dev/           | 200  | Cloudflare Pages → driftstack-marketing                        |
| https://docs.driftstack.dev/          | 200  | Cloudflare Pages → driftstack-docs                             |
| https://app.driftstack.dev/           | 200  | Cloudflare Pages → driftstack-customer-dashboard               |
| https://api.driftstack.dev/health     | 200  | Hetzner production (128.140.37.74) — Fastify + nginx + Node 22 |
| https://staging.driftstack.dev/health | 200  | Hetzner staging (116.203.22.197) — Fastify + nginx + Node 22   |

## Origin TLS

**Mechanism:** Let's Encrypt via DNS-01 challenge.

- **Tooling:** `python3-certbot-dns-cloudflare` (Ubuntu 24.04 system
  package).
- **Auth:** the agent's Cloudflare API token (`Zone:DNS:Edit`)
  via `/etc/letsencrypt/cf-dns-creds.ini`.
- **Cert paths:**
  - prod: `/etc/letsencrypt/live/api.driftstack.dev/{fullchain,privkey}.pem`
  - staging: `/etc/letsencrypt/live/staging.driftstack.dev/{fullchain,privkey}.pem`
    (SAN: `staging.driftstack.dev` + `api.staging.driftstack.dev`)
- **Renewal:** certbot's systemd timer auto-renews every ~60 days.
  Both certs expire 2026-08-07; first auto-renewal lands ~July.
- **TLS handshake captured (Rule L empirical):**

```
TLSv1.3 / AEAD-CHACHA20-POLY1305-SHA256
subject: CN=api.driftstack.dev
issuer:  C=US; O=Let's Encrypt; CN=E8
HTTP/2 200
```

### Spec deviation from V-278.M direction

The founder direction asked for Cloudflare Origin Certificates via
`POST /v4/certificates`. That endpoint requires the legacy
"Origin CA Key" credential (separate from API tokens; viewable at
dash.cloudflare.com → My Profile → API Tokens → API Keys →
"Origin CA Key" → View). Even with `Account:SSL and Certificates:Edit`
on the `cfut_` token, `/v4/certificates` returns
`code 1016 User is not authorized`. Pivoted to Let's Encrypt;
functionally equivalent posture (publicly-trusted CA, auto-renewed),
just a different CA. To switch to Cloudflare Origin CA later, the
founder shares their Origin CA Key + agent re-runs cert generation.

## Sub-processor map (live; matches DPA Annex 3)

- **Hetzner Cloud** (Nuremberg NBG1) — VM compute. Production CPX32 +
  staging CPX22.
- **Neon** (Frankfurt eu-central-1) — managed Postgres 17. Single
  database for v1.0; prod + staging share the `public` schema until
  V-278.K split.
- **Upstash** (eu-central) — managed Redis 7. Single database; prod +
  staging share with `stg:` key prefix until V-278.L split.
- **Cloudflare** (global, EU-jurisdiction R2) — DNS + CDN + Pages +
  Workers + R2, which IS wired into the API and holds customer data:
  avatars (`routes/account-me.ts`), sealed profile blobs
  (`services/profile-store.ts`), status snapshots and archived audit
  rows. V-826 corrected this entry, which described R2 as deferred
  under a heading that calls this map live and says it matches DPA
  Annex 3 — and Annex 3 has listed Cloudflare R2 all along.
- **Postmark** (US) — transactional email; sender domain
  `driftstack.dev` DKIM-verified. Server "driftstack-transactional",
  DeliveryType=Live.
- **Sentry** (DE / EU region) — error tracking. DSN wired into
  production driftstack-api; per-service projects deferred.
- **Stripe** (US, EU subsidiary for SCA) — payment processing.
  TEST-mode keys live; live keys swap in via SSH-write post-BV-KvK
  closure (~2026-05-21).
- **Let's Encrypt** (CA used for origin TLS) — added as a sub-processor
  in this slice; needs DPA Annex 3 update on next legal sweep
  (informational, no customer data flows through them).

## Deferred items (post-checkpoint pickup)

| ID        | Description                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| V-278.J-2 | Per-service Sentry projects (driftstack-dashboard + driftstack-marketing) via org auth token API. |
| V-278.K   | Split shared Neon database into separate prod + staging Neon projects (separate ep-host).         |
| V-278.L   | Split shared Upstash database into separate prod + staging Upstash databases (separate URLs).     |
| F-003     | OAuth (Google / GitHub) signup + signin flow. Tier-1; ~6h after founder unblock.                  |
| Origin CA | Switch from Let's Encrypt → Cloudflare Origin CA when founder shares the Origin CA Key.           |
| R2 wiring | Wire R2 access keys into api `R2_*` env vars to enable avatar upload + V-295c2 status snapshot.   |

## Founder-blocked items

| Item            | Blocker                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| F-001 mobile UI | Need device + URL + screenshot to reproduce; surface unclear (marketing / dashboard / docs?).                    |
| F-003 OAuth     | Founder registers OAuth apps at Google Cloud Console + GitHub Developer Settings; supplies Client IDs + Secrets. |
| NowPayments     | Crypto rail re-evaluation per ADR-002 — no provider chosen yet; not on critical-launch path.                     |
| LiveKit         | V-306-V-308 GUI client streaming; Agent 1 territory + LiveKit account provisioning.                              |
| V-413 Tier-3    | Audit IP/UA leak in account-audit payloads — pending founder verdict on scrub strategy.                          |
| BV KvK closure  | ~2026-05-21; gates Stripe live-mode keys + commercial activation. Test-mode wired today.                         |
| Origin CA Key   | Optional — only needed if founder wants Cloudflare Origin CA over Let's Encrypt for the origin leg.              |

## Tuesday pickup queue

See [`tuesday-pickup.md`](./tuesday-pickup.md) for the full queue. Top
9 priority items captured there.

## V-278 slice index

| Slice        | What                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| V-278.A      | bootstrap.sh + nginx vhosts + systemd unit + .env templates committed.                                                 |
| V-278.A-2    | Bootstrap executed via SSH on both Hetzner servers; Node 22 + nginx + UFW + fail2ban active.                           |
| V-278.B      | Production API deployed; listening 127.0.0.1:7780; /health 200.                                                        |
| V-278.C      | app.driftstack.dev → Cloudflare Pages (driftstack-customer-dashboard).                                                 |
| V-278.D      | docs.driftstack.dev → Cloudflare Pages (driftstack-docs).                                                              |
| V-278.E      | driftstack.dev + www → Cloudflare Pages (driftstack-marketing).                                                        |
| V-278.F      | Staging API deployed; same boot sequence + green /health on origin.                                                    |
| V-278.G      | 38 Drizzle migrations applied to Neon (33 public-schema tables); fixed in-place migration 0028 broken table reference. |
| V-278.H      | 6 DNS records live (api/app/docs/staging/www/apex CNAME-flattened).                                                    |
| V-278.I      | 6/6 public URLs HTTP 200 (after Cloudflare SSL/TLS Flexible flip).                                                     |
| V-278.J      | Sentry DSN wired (production driftstack-api project; Sentry initialized in boot logs).                                 |
| V-278.M      | Full (strict) TLS upgrade with Let's Encrypt origin certs (DNS-01).                                                    |
| V-278 (post) | GIT_SHA injection on /version; CORS allow-list env-driven; dashboard PUBLIC_API_BASE_URL fixed.                        |

## Commit trail (this session, in order)

```
85aee83  V-468: docs/sdk/installation — fold V-455 closure additions
9ed4cba  V-278.B/F production-deploy fixups (live verified)
dc2f51c  V-log: V-278.A-2 / B / C-E / F / H / I execution + 1 SSL/TLS founder ask
3832a60  V-log: V-278.I 6/6 public URLs green + V-278.M in-flight surface
3f153e3  V-278.B/F follow-up: GIT_SHA injection on /version
5c38553  V-278 follow-up: env-driven CORS allow-list for production origins
410ac95  V-log: V-278.B/F follow-ups (GIT_SHA + CORS + dashboard API URL)
b3fe4eb  V-278.M: Full (strict) TLS upgrade — Let's Encrypt DNS-01 origin certs
632a5f2  F-001/F-002/F-003: founder feedback inbox post-V-278.M
```

(Plus 18+ V-NNN slices earlier in the session covering V-455 audit
closure across customer + admin OpenAPI + 3 SDKs + tests + docs.
Full trail in `docs/verification-log.md`.)
