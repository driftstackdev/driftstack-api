# Go-live runbook — fleet control plane + profile-backed sessions

Operator runbook for activating the fleet control plane (live agent sessions on
real Mac nodes, profile-backed storage, the challenge-handling loop). Everything
below is **dormant/flag-gated on origin today** — prod (`api.driftstack.dev`)
runs with the flag off. This is the founder/operator activation sequence.

Sources: config validation traced from `apps/server/src/lib/config.ts` (W403);
crypto from `lib/profile-key-hierarchy.ts` (audited W409); deploy from
`scripts/deploy-bridge.sh` + repo `CLAUDE.md`.

## 1. Prerequisites (env — SSH-write to `/opt/driftstack/api/.env`, never commit)

| Env var                                                     | Required?                   | Notes                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_CONTROL_PLANE_ENABLED`                               | **yes** (`true`)            | Registers the fleet WS endpoint + assembles the registry/node-auth/relays. Off → all of the below inert.                                                                                                              |
| `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` + `LIVEKIT_WS_URL` | **all 3 together**          | `wsUrl` must be `wss://`. Partial → the `/livekit-token` route stays 503 (no half-config).                                                                                                                            |
| `PROFILE_MASTER_KEY`                                        | for profile-backed sessions | base64 → exactly 32 bytes (AES-256). Unset → profiles created without a DEK (feature-inert; non-profile sessions still work). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `REDIS_URL`                                                 | **yes** (prod already set)  | Fleet nonce cache (Ed25519 replay defence) needs real Redis; defaults to localhost otherwise.                                                                                                                         |
| `DRIFTSTACK_FLEET_INTERNAL_TOKEN`                           | if used for fleet ops       | `config.ts:621` — confirm against the fleet-node onboarding flow.                                                                                                                                                     |

Plus: **a registered Mac fleet node** — its Ed25519 public key registered in
`fleet_nodes`, and its own per-node LiveKit creds stored on the node row (the
dispatch mints the session token from `mac.livekit`, not the server config).
Coordinate the Mac node bring-up + keypair registration with A1/A3.

## 2. Deploy (applies migrations incl. 0070, builds remotely, atomic swap)

```
DEPLOY_VIA_BUNDLE=1 ./scripts/deploy-bridge.sh staging   # gate on staging first
DEPLOY_VIA_BUNDLE=1 ./scripts/deploy-bridge.sh prod
```

The deploy runs all pending Drizzle migrations before the new app starts —
including `0070_session_challenge_detected_webhook_event` (additive enum value,
idempotent `ADD VALUE IF NOT EXISTS`).

## 3. Activation sequence

1. SSH-set the §1 env vars on staging `.env`; restart; verify staging boots
   clean (`/health` ok, `/version` = the deployed SHA).
2. Register the Mac node (Ed25519 pubkey + per-node LiveKit creds).
3. Confirm the fleet WS endpoint is up + the node connects (registry size > 0).
4. Repeat on prod.

## 4. Verification (what activates)

- `/v1/agent-sessions` create → dispatched to the node (sessionAssign over the WS).
- Profile-backed session → DEK minted/wrapped (`mintWrappedProfileDek`), restore/save-back R2 URLs in the assign; `profileSaved` persists on close.
- Challenge-handling loop: harness auto-pauses on a bot-challenge → `session.challenge_detected` webhook (subscribe via `POST /v1/webhooks`) → customer `POST /v1/agent-sessions/:id/resume` re-enables.
- `/livekit-token` mints subscriber-only tokens for the live view.

## 5. Rollback

- `scripts/deploy-bridge.sh` keeps the prior release for atomic swap-back; the
  app also has auto-revert wired on a failed health check.
- To deactivate without a redeploy: set `FLEET_CONTROL_PLANE_ENABLED=false` +
  restart → the WS endpoint reverts to the 503 stub, everything inert again
  (migration 0070's enum value is additive + harmless when unused).

## Pre-go-live readiness (A2 side)

All on origin + dormant: dispatch/token/restore/touch, profile DEK hierarchy,
egress (SOCKS5), challenge-handling arc (contract→relay→event-type→resume), the
go-live config validation. No A2 code blockers — this is a secrets + node-bringup

- deploy operation.
