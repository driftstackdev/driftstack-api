# Driftstack API — current status

**Last updated:** 2026-05-10
**HEAD at last checkpoint:** `92da30c`
**Mode:** PAUSED → SEAMLESS HANDOFF (founder switching Claude accounts)

## Seamless handoff prompt for the next Claude session

Paste this verbatim as the first message in the new Claude account:

```
You're picking up an in-flight project. Read in this order, then
report back with a one-paragraph "I'm oriented" summary before
proposing any work:

1. /Users/john/code/driftstack-api/status.md (this file)
2. /Users/john/code/driftstack-api/docs/progress/v278-final-state.md
3. /Users/john/code/driftstack-api/docs/progress/tuesday-pickup.md
4. /Users/john/.claude/projects/-Users-john/memory/MEMORY.md
   (auto-memory; persists across Claude accounts because it's
   user-machine-scoped, not account-scoped)
5. tail -200 /Users/john/code/driftstack-api/docs/verification-log.md

Current pause status: V-278 control plane v1.0 LIVE (6/6 URLs HTTP 200
at TLS 1.3 Full strict). F-002 signup-email is pending Postmark
account approval (form submitted 2026-05-09, expected response by
~2026-05-11; see docs/internal/postmark-approval-request.md). When
Postmark approves, retry signup at app.driftstack.dev/signup with any
external email → verification email arrives within seconds; F-002
closes.

Don't continue the V-294 catalog or fire any new V-NNN slices until
the founder explicitly reactivates autopilot. The session was paused
per cost-discipline (Agent 1 priority through Tuesday).
```

You'll hit a memory directory automatically — Claude Code stores its
auto-memory at `/Users/john/.claude/projects/-Users-john/memory/`,
keyed to the user-machine pair, not the Claude account. So switching
accounts on the same machine preserves all 13 memory rules + project
context.

## What's live right now

All 6 customer-facing URLs HTTP 200 with TLS 1.3 end-to-end
(Cloudflare Full strict mode):

- https://driftstack.dev/ — marketing site (Cloudflare Pages)
- https://www.driftstack.dev/ — marketing site (Cloudflare Pages)
- https://docs.driftstack.dev/ — docs site (Cloudflare Pages)
- https://app.driftstack.dev/ — customer dashboard (Cloudflare Pages)
- https://api.driftstack.dev/health — Fastify control plane (Hetzner production)
- https://staging.driftstack.dev/health — staging mirror (Hetzner staging)

## Session arc summary

This session took the platform from "spec-complete-but-not-deployed"
to "live infrastructure" plus closed the long-running V-455 audit:

- **V-441 → V-455 audit closure** — comprehensive customer-facing
  OpenAPI + 3-SDK + admin OpenAPI parity. 100% covered or
  intentionally 🚫 across every customer-facing route. 1169/1169
  unit/integration tests pass.
- **V-456 → V-468** — closure slices + wire-shape regression tests
  across TS / Python / Go SDKs + customer-facing docs catch-up.
- **V-278 deployment cycle** — bootstrap ➝ deploy ➝ DNS ➝ smoke
  ➝ Sentry. Every slice executed live (V-278.A-2 / B / C / D / E / F
  / G / H / I / J).
- **V-278.M Full (strict) TLS upgrade** — Let's Encrypt DNS-01 origin
  certs (pivoted from Cloudflare Origin Certificates because the
  endpoint requires the legacy Origin CA Key separate from API tokens).
- **F-002 root-causation** — founder reported signup email didn't
  arrive. Empirical: Postmark ledger TotalCount=2 (both from agent
  probes), so the request never reached the API. Root cause was the
  customer-dashboard build embedding `localhost:3000` (PUBLIC_API_BASE_URL
  unset at build time) AND the production CORS allow-list excluding
  the dashboard origin. Both fixed and live; founder retries signup →
  Postmark ledger should record the verification email within seconds.

## Reference docs

- [`docs/progress/v278-final-state.md`](./docs/progress/v278-final-state.md)
  — full V-278 final state + spec deviations + sub-processor map.
- [`docs/progress/tuesday-pickup.md`](./docs/progress/tuesday-pickup.md)
  — queue for next session.
- [`docs/verification-log.md`](./docs/verification-log.md) — full
  V-NNN history (~21,700 lines).
- [`docs/internal/v455-coverage-audit.md`](./docs/internal/v455-coverage-audit.md)
  — audit table (now fully ✅ + 🚫).

## Persistent rules holding

- **V-205 attribution** — `Driftstack <dev@driftstack.dev>` author on
  every commit; zero AI trailers.
- **V-211 anonymity** — no founder name in customer-facing surfaces.
- **Memory rules A through M** (13 rules) — residual classification,
  capture path fallback, empirical proof, orchestrator pre-check,
  agent self-locks, session start orientation, cross-agent boundaries,
  North Star, AI references audit, no idle ScheduleWakeup, surface
  before building, Rule L empirical-diff, Rule M minimum 2 P-track.
- **V-455 audit** — fully closed; 1169/1169 tests green.
- **V-278 LIVE** — `https://api.driftstack.dev/health` returns 200 at
  Cloudflare Full (strict) TLS posture.

## Awaiting founder

- **Postmark account approval** — submitted 2026-05-09 via
  postmarkapp.com/help; founder estimates by Monday. Until approved,
  signups for non-`@driftstack.dev` recipients silently drop at the
  Postmark layer (see
  [`docs/internal/postmark-approval-request.md`](./docs/internal/postmark-approval-request.md)).
  Empirically root-caused 2026-05-09 — same-domain signup probe
  succeeded; cross-domain probe (kidakev946@imashr.com) was rejected
  by Postmark with the pre-approval same-domain restriction.
- F-001 mobile UI bug: device + URL + screenshot to reproduce.
- F-003 OAuth: register OAuth apps at Google Cloud Console + GitHub
  Developer Settings; supply Client IDs + secrets. Callback URL
  pattern `https://api.driftstack.dev/v1/auth/oauth/<provider>/callback`.
- Tuesday reactivation per cost-discipline directive.
