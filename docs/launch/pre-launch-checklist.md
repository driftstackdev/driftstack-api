# Driftstack pre-launch checklist

Roll-up of every item between current state and "first paying customer can sign up, pay, and use the product." Each item is tagged with status (READY / PENDING ENG / PENDING FOUNDER), owner, blocking-launch (yes/no), and rough estimate.

**Source-of-truth structure**:

- This checklist = single-page audit + priority queue.
- Per-runbook detail lives in `docs/founder-actions/v*.md` + `docs/deployment/*.md` + `docs/operations/*.md`.
- Per-V-NNN history lives in `docs/verification-log.md`.

**Last roll-up:** 2026-05-07 (V-279), refreshed 2026-05-07 (V-287),
2026-05-09 (V-361 — V-353 cycle / V-359 / V-298a / V-313 / V-360 +
SDK + audit cleanup absorbed).

---

## 1. Backend (apps/server)

| Item                                       | Status          | Owner   | Blocks launch? | Notes                                                                                                                                                |
| ------------------------------------------ | --------------- | ------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth flows (V-079)                         | READY           | eng     | yes (READY)    | signup / verify-email / login / magic-link / password-reset / refresh / logout                                                                       |
| Web sessions (V-168) + API keys (V-049)    | READY           | eng     | yes (READY)    | scrypt-hashed at rest; Redis-backed AccountContext cache (30s TTL)                                                                                   |
| API key minting + revoke                   | READY           | eng     | yes (READY)    | `POST/GET/DELETE /v1/api-keys` per V-174 scope split                                                                                                 |
| Browser-OAuth GUI activation (V-266)       | READY           | eng     | yes (READY)    | initiate / bind / exchange one-shot 5-min TTL                                                                                                        |
| Sessions (V-073 + V-100)                   | READY           | eng     | yes (READY)    | create / list / navigate / interact / wait / capture / get-state / destroy                                                                           |
| Profiles (V-081)                           | READY           | eng     | yes (READY)    | create / list / get / delete; tier profile-cap enforced                                                                                              |
| Webhooks (V-074 + V-091)                   | READY           | eng     | yes (READY)    | endpoints CRUD + delivery introspection + retry queue                                                                                                |
| Admin force-actions (V-100)                | READY           | eng     | yes (READY)    | session destroy / API key revoke / account suspend                                                                                                   |
| Customer audit log (V-216 + V-354)         | READY           | eng     | yes (READY)    | `GET /v1/account/audit-log` with filter dropdown + load-more pagination on /audit-log dashboard page                                                 |
| MFA (V-353 cycle: a-h + V-358)             | READY           | eng     | yes (READY)    | TOTP enrollment / verify / login challenge / step-up reauth / disable / recovery codes / dashboard UI / API docs. Optional per V-353a verdict        |
| Web-session list + revoke (V-355)          | READY           | eng     | yes (READY)    | GET /v1/account/web-sessions + DELETE per-id + bulk-revoke-except-current. Wired in /settings Active sign-ins                                        |
| Webhook secret rotation (V-359)            | READY           | eng     | yes (READY)    | POST /v1/webhooks/:id/rotate-secret with 24h grace; worker dual-signs; SDK verifiers (TS/Py/Go) accept either header during grace                    |
| Webhook test-delivery (V-356)              | READY           | eng     | yes (READY)    | POST /v1/webhooks/:id/test enqueues synthetic test.ping; UI button per row                                                                           |
| Account avatar (V-352b)                    | READY           | eng     | yes (READY)    | POST/DELETE /v1/account/me/avatar; presigned R2 GET; 2 MiB cap; PNG/JPEG/WebP                                                                        |
| Account slug (V-298a)                      | READY           | eng     | n/a            | accounts.slug column + PATCH /v1/account/me + /settings UI. URL routing semantics deferred to founder design                                         |
| Profile cloning (V-313)                    | READY           | eng     | n/a            | POST /v1/profiles/:id/clone with auto-derived "${source} (copy)" naming                                                                              |
| Stripe Checkout (V-082) + webhooks (V-080) | READY           | eng     | yes (READY)    | six-tier recurring subscription checkout; webhook signature verify                                                                                   |
| BillingService production wiring           | PENDING FOUNDER | founder | yes            | test mode is active; live launch needs `STRIPE_SECRET_KEY` + the 12-price six-tier map + `STRIPE_WEBHOOK_SECRET`. Live keys go via SSH-write only    |
| Free entry tier                            | READY           | eng     | yes (READY)    | perpetual free tier; no card, expiry, one-time purchase, or prepaid credit                                                                           |
| Rate limiting (V-251)                      | READY           | eng     | yes (READY)    | per-account token bucket + per-IP gates on auth endpoints                                                                                            |
| Driver: mock                               | READY           | eng     | n/a            | dev/test only                                                                                                                                        |
| Driver: webkit                             | PENDING ENG     | Agent 1 | yes            | cross-repo dep on Agent 1's V-203 Phase 2A + V-372–V-378 readback-path remediation. Agent 2 ValidationHarnessRecaptureBridge stays mocked until then |
| OpenAPI 3.1 spec emit                      | READY           | eng     | yes (READY)    | `/openapi.json` + Scalar UI at `/docs/`                                                                                                              |
| Test coverage                              | READY           | eng     | n/a            | 1086 / 109 files server + 17 / Python SDK + Go SDK pass; coverage thresholds enforced in CI per V-107                                                |

## 2. SDKs

| Item                               | Status               | Owner | Blocks launch?       | Notes                                                                                                                                                                   |
| ---------------------------------- | -------------------- | ----- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript SDK (`@driftstack/sdk`) | READY                | eng   | yes (READY)          | published on npm; pre-1.0; full resource surface                                                                                                                        |
| Python SDK (`driftstack-sdk`)      | PENDING ENG          | eng   | no (alpha is enough) | wheel-buildable; first PyPI tag pending. Founder direction: launch can ship without Python live                                                                         |
| Go SDK                             | PENDING ENG          | eng   | no (alpha is enough) | examples compile; first git tag pending                                                                                                                                 |
| Webhook signature verifier         | READY (TS + Py + Go) | eng   | yes (READY)          | `verifyWebhookSignature` in TS; `verify_webhook_signature` in Python; `VerifyWebhookSignature` in Go. V-359-sdk extended all three with `headerPrev` for rotation grace |

## 3. GUI client (apps/gui-client)

| Item                                                                    | Status          | Owner   | Blocks launch?                     | Notes                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------- | ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| First-run wizard (V-244 + V-261)                                        | READY           | eng     | yes (READY)                        | Welcome → Cloud/Self-hosted with pricing → Sign in → First profile                                                                          |
| Browser-OAuth flow (V-268)                                              | READY           | eng     | yes (READY)                        | shared `useBrowserSignIn` hook; paste fallback retained                                                                                     |
| API-key-paste fallback                                                  | READY           | eng     | yes (READY)                        | toggle in wizard step 3                                                                                                                     |
| Settings: connected / sign-out / inline browser-sign-in (V-272 + V-274) | READY           | eng     | yes (READY)                        | reuses V-268 plumbing                                                                                                                       |
| Empty states across 4 list views (V-265 + V-275–V-277)                  | READY           | eng     | yes (READY)                        | Sessions / Profiles / Recordings / Proxies — consistent oxblood-tinted icon + onboarding copy                                               |
| Sentry crash-only telemetry (V-242)                                     | READY           | eng     | yes (READY)                        | opt-in default per platform                                                                                                                 |
| OS keychain for API key (V-241)                                         | READY           | eng     | yes (READY)                        | macOS Keychain / Windows Credential Manager / Linux Secret Service                                                                          |
| Tauri Updater wired (V-243)                                             | READY           | eng     | yes (READY)                        | manifest published from gui-release workflow                                                                                                |
| macOS code signing                                                      | PENDING FOUNDER | founder | yes                                | Apple Developer cert ($99/yr) + Developer ID Application certificate. Without: Gatekeeper warns on first launch                             |
| Windows code signing                                                    | PENDING FOUNDER | founder | softens UX                         | EV cert (~$200+/yr) for SmartScreen reputation. Without: SmartScreen warns until reputation accumulates                                     |
| Linux package signing                                                   | PENDING         | founder | no (deferred per D-2026-05-06-03c) | unsigned `.AppImage` is fine for technical operators                                                                                        |
| Tauri Updater signing keys (V-243)                                      | COMPLETE        | founder | yes (READY)                        | TAURI_UPDATER_PUBKEY / PRIVKEY / PRIVKEY_PASSWORD GitHub secrets set 2026-05-07. Runbook: `docs/founder-actions/v243-tauri-updater-keys.md` |
| First gui-v0.1.0 tag                                                    | PENDING FOUNDER | founder | yes                                | fires CI release pipeline; can ship Linux-only `.AppImage` first if Apple/Windows certs not yet set up                                      |
| Tauri custom URL scheme                                                 | DEFERRED        | eng     | no                                 | Polling works end-to-end. Cross-platform native-bundle work; not launch-blocking                                                            |

## 4. Customer dashboard (apps/customer-dashboard)

| Item                                                   | Status          | Owner   | Blocks launch? | Notes                                                                                                          |
| ------------------------------------------------------ | --------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| Signup → verify-email → welcome flow                   | READY           | eng     | yes (READY)    | V-184a-era                                                                                                     |
| Login (V-269)                                          | READY           | eng     | yes (READY)    | POSTs `/v1/auth/login`; honours `?next=`                                                                       |
| Forgot password / reset password (V-273)               | READY           | eng     | yes (READY)    | wires V-079 backend                                                                                            |
| `/cli/authorize` (V-267)                               | READY           | eng     | yes (READY)    | dashboard side of V-266 OAuth flow                                                                             |
| `/api-keys` create + revoke (V-270)                    | READY           | eng     | yes (READY)    | wired CRUD; previously placeholder anchors                                                                     |
| Sessions / profiles / billing / usage / webhooks pages | PARTIAL         | eng     | no (cosmetic)  | live-read wiring in place via V-180–V-184 progressive enhancement; some still show mock data when token absent |
| Tier-select page                                       | READY           | eng     | yes (READY)    | post-signup tier picker                                                                                        |
| Cloudflare Pages deploy workflow (V-260)               | READY           | eng     | yes (READY)    | skip-on-missing-secret pattern                                                                                 |
| CF Pages project + DNS wiring                          | PENDING FOUNDER | founder | yes            | per V-259 runbook                                                                                              |

## 5. Marketing site (apps/marketing-site)

| Item                                                                  | Status          | Owner   | Blocks launch?                     | Notes                                                                        |
| --------------------------------------------------------------------- | --------------- | ------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| Landing (`/`)                                                         | READY           | eng     | yes (READY)                        | brand identity + pricing pointer + value prop                                |
| `/pricing` (current six-tier catalog)                                 | READY           | eng     | yes (READY)                        | free entry plus Manual/API recurring tiers; Enterprise is sales-assisted     |
| `/security`                                                           | READY           | eng     | yes (READY)                        | six-pillar security framing (count corrected S26 2026-07-06 (#132))          |
| `/faq`                                                                | READY           | eng     | yes (READY)                        | covers pricing model + Manual vs API + concurrency + self-hosted             |
| `/about` + `/changelog` + `/self-hosted` + `/api-reference` + `/docs` | READY           | eng     | yes (READY)                        | all production-shaped                                                        |
| `/legal/{terms,privacy,dpa,aup}` (V-264)                              | READY           | eng     | yes (binding pending counsel)      | launch-ready prose; Driftstack B.V. entity throughout; v1.0; no DRAFT banner |
| `/trust/sub-processors` (V-052 + V-091)                               | READY           | eng     | yes (READY)                        | sub-processor register; lockstep with DPA Annex 3 (V-271 linter)             |
| Counsel review of legal pages                                         | PENDING FOUNDER | founder | yes (before first paying customer) | per `docs/legal/README.md` revision-trigger rule                             |
| CF Pages project + DNS wiring                                         | PENDING FOUNDER | founder | yes                                | per V-259 runbook                                                            |
| Deploy workflow                                                       | READY           | eng     | yes (READY)                        | `.github/workflows/deploy-marketing.yml`; skip-on-missing-secret             |

## 6. Doc site (apps/docs)

| Item                                                                                       | Status          | Owner   | Blocks launch? | Notes                                                                     |
| ------------------------------------------------------------------------------------------ | --------------- | ------- | -------------- | ------------------------------------------------------------------------- |
| Quickstart, SDK install, License activation, Profile management, Session lifecycle (V-256) | READY           | eng     | yes (READY)    | working code samples; verified against shipped endpoints; ADR-004 pricing |
| API + SDK + Webhooks reference (V-254)                                                     | READY           | eng     | yes (READY)    | versioning policies + event catalog                                       |
| Landing + nav (V-257)                                                                      | READY           | eng     | yes (READY)    | onboarding-shape: Get started / Concept guides / Reference                |
| Deploy workflow (V-258)                                                                    | READY           | eng     | yes (READY)    | `.github/workflows/deploy-docs.yml`                                       |
| CF Pages project + DNS                                                                     | PENDING FOUNDER | founder | yes            | per V-258 runbook                                                         |

## 7. Infrastructure (Hetzner / Neon / Upstash / Cloudflare / Postmark / Sentry)

| Item                                       | Status          | Owner   | Blocks launch? | Notes                                                                                            |
| ------------------------------------------ | --------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------ |
| Hetzner two-VM provisioning                | PENDING FOUNDER | founder | yes            | CCX13 staging + CCX23 production in Falkenstein. Runbook: V-278.                                 |
| Cloudflare Pages 4 projects                | PENDING FOUNDER | founder | yes            | per V-259 runbook                                                                                |
| Neon EU databases                          | PENDING FOUNDER | founder | yes            | staging + production                                                                             |
| Upstash EU Redis                           | PENDING FOUNDER | founder | yes            | TLS-enabled, EU region                                                                           |
| Cloudflare R2 buckets                      | PENDING FOUNDER | founder | yes            | recordings-staging + recordings-prod                                                             |
| Postmark sending region (EU)               | PENDING FOUNDER | founder | yes            | dedicated server token; FROM + REPLY_TO addresses                                                |
| Sentry projects (EU ingest)                | PENDING FOUNDER | founder | yes            | staging + production environments                                                                |
| GitHub Environments (staging + production) | READY           | eng     | yes (READY)    | workflow-side wiring done; founder populates secrets per V-278                                   |
| Deploy workflows (server + 4 frontends)    | READY           | eng     | yes (READY)    | all skip-on-missing-secret; mirror the same shape across V-258/259/260/278                       |
| DNS records (driftstack.dev zone)          | PARTIAL         | founder | yes            | apex + www handled by CF Pages; api / app / docs / admin subdomains land per per-project runbook |

## 8. Legal + corporate

| Item                                      | Status          | Owner   | Blocks launch? | Notes                                                                                                                |
| ----------------------------------------- | --------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| BV legal entity (KvK closure)             | PENDING FOUNDER | founder | yes            | target ~2026-05-21 per memory. Unblocks live-mode Stripe + populates address / KvK / BTW placeholders in legal pages |
| Counsel review of legal docs              | PENDING FOUNDER | founder | yes            | required before first paying customer per `docs/legal/README.md`                                                     |
| `POST /v1/legal/accept` content_hash sync | READY           | eng     | yes (READY)    | server reads from `docs/legal/*.md` at startup; content_hash recorded on accept                                      |
| Sub-processor mirror linter (V-271)       | READY           | eng     | yes (READY)    | Article 28(2) drift gate                                                                                             |

## 9. Customer support readiness

| Item                           | Status          | Owner   | Blocks launch? | Notes                                                                                           |
| ------------------------------ | --------------- | ------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `support@driftstack.dev` email | PENDING FOUNDER | founder | yes            | Postmark or Google Workspace inbox. Surfaced in legal pages + GUI Settings + dashboard          |
| `privacy@driftstack.dev`       | PENDING FOUNDER | founder | yes            | dedicated address per Privacy Policy + DPA contact section                                      |
| `legal@driftstack.dev`         | PENDING FOUNDER | founder | yes            | dedicated address per ToS notice clause                                                         |
| `abuse@driftstack.dev`         | PENDING FOUNDER | founder | yes            | per AUP                                                                                         |
| `security@driftstack.dev`      | PENDING FOUNDER | founder | yes            | per DPA TOM section F                                                                           |
| Status page                    | PARTIAL         | eng     | softens UX     | `/v1/status` JSON exists; public status.driftstack.dev surface deferred. Acceptable for launch. |
| Admin panel                    | PARTIAL         | eng     | yes            | core admin endpoints exist (V-100, V-216 etc); admin UI scaffolding only — needs V-281 polish   |
| Refund procedure documented    | PENDING ENG     | eng     | softens UX     | V-280 launch-day runbook covers manual refund flow                                              |
| Day-1 known-issue list         | PENDING ENG     | eng     | softens UX     | V-280 launch-day runbook                                                                        |

## 10. Observability + operations

| Item                                  | Status           | Owner | Blocks launch?                                                   | Notes                                                                                                                                                     |
| ------------------------------------- | ---------------- | ----- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry error tracking (V-117 + V-242) | PARTIAL          | mixed | yes (wiring READY; GUI DSN COMPLETE; server DSN PENDING FOUNDER) | server + GUI client wiring done. GUI client `VITE_SENTRY_DSN` GitHub secret set 2026-05-07. Server-side `SENTRY_DSN` lands with production .env per V-278 |
| Pino structured logs                  | READY            | eng   | yes (READY)                                                      | every layer; request id correlation                                                                                                                       |
| `/health` + `/ready` endpoints        | READY            | eng   | yes (READY)                                                      | deploy workflows curl `/health` post-deploy                                                                                                               |
| Migration journal sync (V-228)        | READY            | eng   | yes (READY)                                                      | pre-push hook backstop                                                                                                                                    |
| CI gates (V-223)                      | READY            | eng   | yes (READY)                                                      | typecheck + lint + format + tests + sub-processor mirror                                                                                                  |
| Perf regression check (V-165)         | READY (advisory) | eng   | n/a                                                              | bench-regression.yml in advisory mode; not a hard gate                                                                                                    |
| Disaster recovery runbook             | READY            | eng   | yes (READY)                                                      | `docs/deployment/dr-runbook.md`                                                                                                                           |
| Day-to-day operations runbook         | READY            | eng   | yes (READY)                                                      | `docs/deployment/runbook.md`                                                                                                                              |
| Launch-day runbook                    | PENDING ENG      | eng   | yes                                                              | V-280 lands this                                                                                                                                          |

---

## Minimum-launchable surface (pre-payment-customer)

To launch in the technical sense (signup works, GUI activation works, sessions create + drive + destroy, dashboard reflects state), all "READY" items above suffice plus:

1. Hetzner VMs provisioned (V-278 runbook).
2. Cloudflare Pages 4 projects + DNS (V-259 runbook).
3. Neon + Upstash + R2 + Postmark + Sentry per V-278 production-env-schema.

That's ~30-60 minutes of founder dashboard work spread across the V-258/V-259/V-278 runbooks.

## Minimum-launchable surface (first-paying-customer-acceptable)

Add to the above:

1. BV KvK closure (~2026-05-21 target).
2. Counsel review of legal pages (any verdict — accept / amend; latter forces a 1.x bump).
3. Stripe live-mode keys + canonical 12 recurring price IDs (post-KvK; SSH-write only).
4. macOS Apple Developer cert + Tauri Updater signing keys (for trustworthy GUI client distribution).
5. First `gui-v0.1.0` tag fired (release pipeline produces signed binaries).

## Founder action queue (priority order)

Closed since V-279 (2026-05-07):

- ✅ **Tauri Updater signing keys** — TAURI_UPDATER_PUBKEY/PRIVKEY/PRIVKEY_PASSWORD GitHub secrets set 2026-05-07. GUI release pipeline can now sign updates.
- ✅ **GUI client Sentry DSN** — VITE_SENTRY_DSN GitHub secret set 2026-05-07. Crash telemetry from desktop builds will reach the EU Sentry ingest once a customer opts in (V-242).

Remaining, in priority order:

1. **Hetzner two-VM provisioning** (V-278 runbook, ~20-30 min) — unblocks everything backend.
2. **Cloudflare Pages 4 projects + DNS** (V-259 runbook, ~20 min) — unblocks marketing / dashboard / docs / admin deploys.
3. **Neon + Upstash + R2 + Postmark + server-side Sentry DSN populated in production .env** (V-278 production-env-schema, ~30-45 min) — unblocks first staging deploy. Server-side `SENTRY_DSN` is part of this batch (lands via SSH-write in `DEPLOY_DOTENV_BASE64`); GUI-client `VITE_SENTRY_DSN` already set above.
4. **First push-to-main triggers staging deploy** — verify `https://staging.driftstack.dev/health` returns 200.
5. **First `server-v0.1.0` tag** — verify production deploy via tag-pipeline (canonical per V-283 release policy).
6. **Apple Developer cert + Tauri release setup** (~$99/yr ongoing + ~30 min one-time) — unblocks signed macOS builds.
7. **First `gui-v0.1.0` tag** — produces signed binaries; can ship `.AppImage` first if Apple cert not yet set up.
8. **BV KvK closure** (~2026-05-21 target) — unblocks live-mode Stripe + legal page placeholders → real values.
9. **Counsel review of legal docs** — required before first paying customer per README's preserved gate.
10. **Stripe live-mode keys + canonical 12 recurring price IDs** (post-KvK; SSH-write only) — switches BillingService from the currently active test-mode catalog to live mode.
11. **First paying customer.**

## What's deferred post-launch (not blocking)

- Tauri custom URL scheme (deep-link replacement for V-268 polling).
- Python + Go SDK first-tag-on-PyPI / first-tag-on-modules.
- Public status page (status.driftstack.dev).
- V-184b copy redline.
- V-256 explicit deferrals (SDK matrix Streaming/Recording rows, etc.).
- Crypto rail re-evaluation (deferred per ADR-002 supersedure to fiat-only).
- GUI ProfilesView/RecordingsView/ProxiesView further polish (V-275–V-277 closed empty-states).

## Cross-repo dependencies (Agent 1)

- **WebKit-fork driver integration** (V-203 Phase 2A + V-372–V-378 readback-path remediation). Currently `DRIVER=mock` in production; switching to `DRIVER=webkit` requires the bridge.
- **`ValidationHarnessRecaptureBridge`** stays mocked until Agent 1's bridge ships.
- **None of the above block Agent 2 launch-infrastructure work** — Agent 2 ships everything except the actual session-execution layer; Agent 1 lands the actual fleet.
