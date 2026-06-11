# v1 launch readiness — Agent-2 (control plane) honest assessment

**2026-06-11 (W596).** Founder asked for "major work + planning" — this is the
grounded A2-scope picture: what's done + live, what's gated on founder _data_
(trivial), and what's genuinely blocking a real v1 (work/decisions, not data).
Scope = driftstack-api (server, dashboard, admin, docs, marketing, SDKs, GUI).
A1 (WebKit fork/atlas) + A3 (harness/runtime) carry their own readiness.

## ✅ Done + verified live on prod (542aa089)

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
- GUI cloud-vs-self-hosted: founder should use **Cloud mode** for daily use.

## Bottom line

The control plane + customer surfaces are **v1-complete and prod-stable**. The
two things standing between "demo" and "real launch" are both outside pure A2:
**a real driver (Mac + A1 fork)** and **the webhook delivery worker**. The
founder-data gates (R2, Stripe) are minutes of work once values arrive.
