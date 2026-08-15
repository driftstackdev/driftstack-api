# v1 launch readiness — Agent-2 (control plane) honest assessment

**2026-06-11 (W596; refreshed W622 same day, prod now d5e50623).** Founder
asked for "major work + planning" — this is the grounded A2-scope picture:
what's done + live, what's gated on founder _data_ (trivial), and what's
genuinely blocking a real v1 (work/decisions, not data). Scope =
driftstack-api (server, dashboard, admin, docs, marketing, SDKs, GUI).
A1 (WebKit fork/atlas) + A3 (harness/runtime) carry their own readiness.

## ✅ NEW since W596 (the 2026-06-11 W607–W621 batch, live on prod d5e50623)

- **Desktop GUI browser-UX arc COMPLETE** (founder-greenlit "do all"): URL
  bar + reload, toggleable iPhone bezel (frame-aspect-driven), browser tabs
  (= concurrent sessions, 10s list poll), page loading bar + per-kind page
  error overlays, Dev Logs error capture ([api] non-2xx + [ui] banners —
  root-caused 4 founder-hit bugs same-hour), launch degradation chain
  (no-LiveKit → instant viewer; empty room → 10s honest offer; publisher →
  stream). Installed on the founder's Mac.
- **`sensitive` typing flag e2e** (A3's W1149/W1150 ask): api-types +
  3 SDKs + dispatch wire + docs; A3's harness threading already landed
  their side — feature live across both agents.
- **`page_state` on session state** (loading/loaded/errored + error kind):
  schema → drivers → route → SDKs → docs → GUI render. A3's rich emit is
  the assigned remainder (relay Addendum 7 GO).
- **`SESSION_PROXY_REQUIRED` tri-state** (founder verdict): self-hosted
  creates sessions proxy-free; cloud posture unchanged.
- **Python SDK spec catch-up**: openapi.json + generated models were stale
  since W540 (~70 waves) — regenerated + drift-guarded.
- **Deploys during the Actions outage**: docs / marketing+changelog
  redeployed manually; staging→prod soak cycle ×2 (prod = d5e50623).

## ✅ Done + verified live on prod (now d5e50623; W596 baseline below)

- **Auth + accounts**: signup/verify/login/MFA/web-session, API keys
  (mint/rotate/revoke/scopes), owner+staff admin via env. Login outage fixed
  (apiBaseUrl), dashboard + admin pointed at prod.
- **Agent sessions**: ai / manual / pair modes, decompose→execute loop, BYOK +
  bundled LLM rails, per-session model picker, SSE transcript stream (+ CORS
  fixed), token budgets.
- **Safety**: prompt-injection framing, consequential-action confirm, and the
  task-refusal start-gate (mechanism→wiring→activation→starter list) — inert
  until the founder sets the pattern env var.
- **Billing surface**: tier/usage/rate-limit dashboard, crypto checkout, honest
  503 when Stripe not yet wired. **Stripe itself is gated (below).**
- **Platform**: rate limits (+ IETF headers), idempotency, pagination, webhooks
  API + signature verify, errors.driftstack.dev (all 29 type-URIs), docs
  (quickstart + 3-SDK + guides), status page, email templates, deploy guard.
- **Deploy/ops**: prod+staging bundle deploy, auto-revert, 16-point smoke,
  frontend deploy guard (can't ship localhost apiBaseUrl again).

## 🟡 Gated on founder DATA only (minutes to resolve, not real work)

1. **R2 object storage** — prod has 3/5 keys; needs `R2_ACCESS_KEY_ID` +
   `R2_SECRET_ACCESS_KEY` (R2 dashboard → Manage API Tokens). Until then
   recordings/avatars durability is off (r2:false, degrades gracefully). I
   SSH-add + restart once provided.
2. **Stripe live key** — swap `STRIPE_SECRET_KEY` test→live post-BV/KvK. Until
   then billing is honestly "not configured" (no mock). Q.2 guard enforces.
3. **Task-refusal activation** — set `DRIFTSTACK_TASK_REFUSAL_PATTERNS` to the
   reviewed starter list. Optional; gate is a safe no-op until then.

## 🔴 Genuinely blocking a _real_ v1 (work / decisions, A2 can't close alone)

1. **Mac worker — `driver=mock` in prod.** THE blocker for real browser
   sessions: every session is currently a mock. Role split (founder-clarified
   2026-06-11): **A1** makes the WebKit fork bit-identical (the browser);
   **A3** owns the harness/runtime that _drives_ it (drive-bridge, already
   built — gated on A1's `--enable-webdriver` fork-deploy + flipping
   `DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1`); **A2's** control-plane dispatch side
   (session-create → /v1/agent-sessions → LiveKit) is **done + live**. So the
   real-drive integration is A1-fork + A3-runtime + a Mac — not A2 work.
2. **Webhook delivery worker unwired in prod** — the API enqueues deliveries
   but no prod driver POSTs them (0 endpoints fire). Latent; founder-gated
   (don't auto-wire). Needed before webhooks are a real customer feature.

## 🔵 Cross-agent / founder decisions (not A2-blocking, tracked)

- Archetype matrix (A1's 81 configs) — A2 is matrix-ready, dashboard list
  expands when A1 ships + founder picks which to sell.
- Behavioral undetectability model ownership (A1/A3 source of truth).
- GUI per-session HID input channel (Tier-2 architecture, cross-agent A1).
- GitHub account flag (deploys use bundle-mode workaround meanwhile).
  **W608 finding: Actions runs have been silently DEAD since 2026-06-08
  02:19** — the API says enabled but ~30 pushes triggered zero runs. The
  local pre-push gate is the only test gate; CI-only real-PG drizzle tests
  are unvalidated since then. Worth adding to the GitHub support thread.
- GUI cloud-vs-self-hosted: founder should use **Cloud mode** for daily use.

## Bottom line

The control plane + customer surfaces are **v1-complete and prod-stable**. The
two things standing between "demo" and "real launch" are both outside pure A2:
**a real driver (Mac + A1 fork)** and **the webhook delivery worker**. The
founder-data gates (R2, Stripe) are minutes of work once values arrive.

---

## VERIFICATION 2026-08-15 — what has changed since this was written

This document is dated **2026-06-11** and was accurate then. It is now **two
months old**, and a readiness doc that is read as current is worse than one that
is obviously stale, because its blockers get planned around. Re-checked against
the code today; the original text above is left intact as the record.

### 🔴 → ✅ Blocker 2 (webhook delivery worker) has SHIPPED

The doc says "the API enqueues deliveries but no prod driver POSTs them (0
endpoints fire)… Needed before webhooks are a real customer feature."

**That is no longer true.** `lib/bootstrap.ts` constructs a `WebhookDeliveryWorker`
and runs it on a poller. It is not a stub: the tick **drains** (keeps claiming
while the previous batch came back full), bounded by a maximum batch count and a
wall-clock budget inside the poll interval, with an overlap guard so a slow drain
cannot multiply in-flight deliveries, per-attempt timeouts, and both delivery
metrics wired. The source also records the bug that made those counters
unincrementable in production, now fixed.

**Do not plan around this blocker.** Whether it is ENABLED on the prod host is a
deployment question I cannot answer from the repo — see the limits below — but
the "no worker exists" statement is stale.

### Minor drift

- "errors.driftstack.dev (all **29** type-URIs)" — `PROBLEM_TYPES` now carries
  **32**. The cross-SDK parity test separately pins 24 as the canonical subset
  every SDK must map, which is a different number for a different reason and is
  not drift.

### What I did NOT verify, and why

Three of this document's claims need the production host, and A2 does not take
SSH without an explicit live-bus grant:

- **`driver=mock` in prod** (blocker 1) — unverified. The A1-fork + A3-runtime
  split it describes is cross-agent and outside A2 regardless.
- **R2 / Stripe env keys** (the two founder-data gates) — unverified.
- **GitHub Actions dead since 2026-06-08** — unverified from the repo.

Stating these as unverified rather than assuming they still hold is the point:
the two months that made blocker 2 stale applied to them equally.

### How to keep this from recurring

The failure mode is not that the doc was wrong — it was right on 2026-06-11. It
is that nothing in it said **when to distrust it**. Anything that reads as a
launch decision input needs a re-verification date, and the cheapest version is
the one used here: re-check only the claims the repo can settle, and mark the
rest unverified rather than silently carrying them forward.
