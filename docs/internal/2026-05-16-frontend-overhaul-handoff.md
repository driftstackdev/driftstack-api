# Frontend overhaul — 2026-05-16 progress handoff

7 waves, ~27 commits across 2026-05-16 against the 8-issue / 10-slice
founder directive landed mid-day. This handoff records the slice-by-
slice state so a fresh session can pick up without re-reading every
commit.

## Slice status

| Slice    | Description                                                                                              | State                                      |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **F-1**  | Mobile responsive (overflow-x clip + code wrap, 5 surfaces)                                              | ✅ done                                    |
| **F-2**  | Homepage copy revision (Pixel-identical / API,SDK,GUI; product-differentiator strip)                     | ✅ done                                    |
| **F-3**  | Footer revision (compliance badges → product signals; legal collapsed to meta row; /roadmap from header) | ✅ done                                    |
| **F-4**  | Homepage SDK example AI-agent section (createWithAgent shape)                                            | ✅ done                                    |
| **F-5**  | EU/infrastructure copy + aspirational-language strip                                                     | 🟡 partial — see below                     |
| **F-6**  | Marketing-site remaining pages                                                                           | 🟡 audit complete, fixes batched into F-5  |
| **F-7**  | Customer-dashboard customer-facing copy                                                                  | 🟡 settings + webhooks + signup OAuth done |
| **F-8**  | Docs site introductory copy                                                                              | 🟡 guides/index + sdk/versioning done      |
| **F-9**  | Status-site copy                                                                                         | ✅ clean (audit found no violations)       |
| **F-10** | Cross-page consistency review                                                                            | ❌ not started (low priority, polish)      |

## Founder-issue coverage

| Issue | Description                                       | State                                                              |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------ |
| **1** | Mobile responsive broken                          | ✅ closed (F-1)                                                    |
| **2** | AI-prompt SDK example                             | ✅ closed (F-4)                                                    |
| **3** | Strip AI/legal terminology in prominent positions | ✅ closed (footer + homepage)                                      |
| **4** | Homepage honest copy revision                     | ✅ closed (F-2)                                                    |
| **5** | No "future" / "coming soon" / "roadmap" framing   | 🟡 see "Known exceptions" below                                    |
| **6** | EU/infrastructure copy strip + promote proxies    | 🟡 see "Known exceptions" below                                    |
| **7** | Footer badges → product-focused content           | ✅ closed (F-3)                                                    |
| **8** | Apply across all pages                            | 🟡 marketing-site fully audited; customer-dashboard + docs partial |

## Known exceptions (gated by parity tests + flagged for founder)

### The egress-card contradiction

The homepage F-2 product-differentiator strip promotes **SOCKS5 ·
WireGuard · OpenVPN proxies** as a launch feature (per founder Issue 6).
However:

- `apps/marketing-site/src/pages/security.astro:50-63` egress card says
  "no server-side implementation ships today"
- `apps/marketing-site/src/pages/trust/index.astro:55-56` says
  "Customer-configurable egress is on the roadmap"
- `apps/marketing-site/src/pages/trust/security-overview.astro:113` says
  "tunnels) is on the roadmap. Today, session network..."
- `apps/marketing-site/src/pages/index.astro:475` code-preview comment
  says "Roadmap — customer-configurable egress" + "(not shipped)"

These four surfaces are gated by parity tests
(`security-page-doc-parity.test.ts`, `trust-index-doc-parity.test.ts`,
`marketing-site-pages-trust-security-overview-content-parity.test.ts`,
`marketing-site-pages-index-content-parity.test.ts`) that detect
`customerEgress|egress_config|proxyUrl|SOCKS5` in the actual
`apps/server/src/` source. If those tokens don't appear, the tests
REQUIRE the docs say "roadmap". Today the tokens don't appear, so the
tests force the disclaimer to stay.

**Right next step:** either land the egress server implementation
(removes the contradiction by validating the homepage claim) OR
soften the homepage F-2 strip to remove the SOCKS5/WireGuard/OpenVPN
proxy promotion. Both require founder decision. Flagged in commit
messages `91cff342` + `7bcd63e7` + `e7f99e51`.

### The recordings docs page

`apps/marketing-site/src/pages/docs/recordings.astro` lead paragraph
keeps the word "roadmap" because the W217.A parity test asserts the
page MUST claim "planned, not live" until the recordings endpoint
ships server-side. Same code-gated pattern as egress. Page no longer
has any `<a href="/roadmap">` link though (Issue 5 done in spirit).

### The /roadmap page itself

The `/roadmap` page still exists at `apps/marketing-site/src/pages/
roadmap.astro` but is no longer linked from any nav surface (footer

- header + faq + recordings all stripped). Page content is full of
  aspirational claims that violate Issue 5. Deciding whether to:

* **(a)** Delete the page entirely (lose any indexed/bookmarked
  inbound traffic; user-facing 404)
* **(b)** Rewrite the page as a "what's shipping next" pinned to
  launch features only
* **(c)** Leave orphaned but reachable (current state)

is a founder decision flagged for the next iteration.

## Memory rules respected

- `feedback_no_solo_dutch_founder_framing` — "solo-founder Dutch BV"
  removed from about.astro SEO description; "Dutch BV" kept in the
  Company Facts dl/dd table (factual legal-entity disclosure, not
  marketing framing — different scope).
- `feedback_no_coauthor_trailer` — every commit body landed without
  the Anthropic Co-Authored-By trailer.
- `project_dashboard_origin_single_source` — OAuth Path A wire-up
  consumes `config.dashboardOrigin` (the single source of truth) for
  the per-provider redirect target.
- `feedback_rule_r_per_wave_commit_discipline` — every wave committed
  per-track, no pile ever exceeded ~5 files.
- `feedback_rule_m_v2_max_5_consecutive_same_track` — every wave
  rotated ≥3 tracks (frontend / OAuth / ops / parity).
- `feedback_schedulewakeup_does_not_run_overnight` — no
  ScheduleWakeup; foreground-only across all 7 waves.

## OAuth V-667.C Path A status

Code-side **complete** at `952a2216` + `bdd246e0` + `aba44a9f`:

- Per-provider callback URLs derived from `OAUTH_CLIENT_CALLBACK_URL_BASE`
- New `/v1/auth/oauth/{google,github}/callback` routes that 302 to
  the SPA exchange page preserving the IDP's query string
- Token-exchange `redirect_uri` matches what authorize sent
- Login + signup pages have brand-icon SVG OAuth buttons
- No silent fallback from the old env var (would have reproduced the
  redirect_uri_mismatch bug from a different code path — see
  `aba44a9f`)
- Runbook updated with safe rollout sequence at
  `docs/runbooks/oauth-client-go-live.md`

**Operator next steps (Tier-1 authorized per founder):**

1. SSH both servers: ADD `OAUTH_CLIENT_CALLBACK_URL_BASE=https://api.driftstack.dev/v1/auth/oauth`
   to `/opt/driftstack/api/.env` alongside the existing
   `OAUTH_CLIENT_CALLBACK_URL` (no restart yet — live code reads old
   name).
2. `bash scripts/deploy-bridge.sh staging` — deploys new code, picks
   up new env name on restart, oauthClient:true on boot log.
3. Real-IDP smoke on https://app.driftstack.dev/login (staging).
4. Repeat for prod: `bash scripts/deploy-bridge.sh prod`.
5. Real-IDP smoke at https://app.driftstack.dev/login (prod).
6. Optionally remove the now-unused `OAUTH_CLIENT_CALLBACK_URL` var.

This sequence has **zero OAuth-downtime window** — at no point are
both env vars absent.

## What's queued but not started

- V-500 pricing detail page implementation (large, multi-wave)
- V-501 onboarding wizard polish (large)
- V-503 security overview public page (large)
- V-278.K Neon split execution (operator neonctl auth required)
- V-278.L Upstash split execution (operator Upstash console auth)
- deploy.yml Option B rewrite (re-authorized Tier-1; large refactor)
- F-10 cross-page consistency review (polish, low priority)

Each is a 1+ wave dedicated effort. Today's 7 waves stayed within
bounded slices on the F-1 through F-8 directive surface.
