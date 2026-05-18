-- LK.1 — per-Mac LiveKit credentials on the fleet_nodes table.
--
-- Phase H.18.b cross-agent handoff: Agent 1 ships PER-MAC LiveKit
-- Server (brew install + launchd KeepAlive + Caddy TLS + Swift SDK
-- build) running on every Mac mini in the fleet. Each Mac mints its
-- own LiveKit API key + secret pair on install and POSTs them to
-- the control plane on harness boot (LK.2 follow-up).
--
-- The control plane uses these credentials to mint JWT tokens for
-- gui-client subscribers (LK.3) without any RPC to the Mac side —
-- the signing happens entirely server-side once the credentials
-- are stored.
--
-- Column reuse: extends the existing V-820 fleet_nodes table (the
-- canonical Mac fleet inventory) rather than introducing a parallel
-- mac_nodes table. The orchestrator brief used "mac_nodes" as a
-- gloss for what we already track in fleet_nodes; the data model
-- alignment is identical.
--
-- Secret handling: livekit_api_secret_ciphertext stores the secret
-- as AES-256-GCM ciphertext under the existing MFA_ENCRYPTION_KEY
-- (same envelope as BYOK Anthropic + gui_control_key per the
-- V-494 + obs.2 / obs.2.b log-redact matrix). Plaintext is never
-- persisted; decryption happens in-memory at JWT mint time only.
--
-- Nullable columns: a fleet_node row may exist before LK.2 register
-- has been called (e.g. V-820 WebSocket handshake registration that
-- pre-dates the LiveKit harness install). Nullability lets the
-- LK pipeline opt in per-node without forcing a batch migration of
-- pre-existing rows.

ALTER TABLE "fleet_nodes"
  ADD COLUMN "livekit_api_key" text NULL,
  ADD COLUMN "livekit_api_secret_ciphertext" text NULL,
  ADD COLUMN "livekit_ws_url" text NULL,
  ADD COLUMN "livekit_registered_at" timestamptz NULL;

-- Cross-column invariant: either ALL four LiveKit fields are set,
-- or all four are NULL. Forbid the half-registered state that
-- could otherwise produce "we have an api_key but no signing
-- secret" -class bugs at JWT mint time.
ALTER TABLE "fleet_nodes"
  ADD CONSTRAINT "fleet_nodes_livekit_all_or_none" CHECK (
    (
      "livekit_api_key" IS NULL
      AND "livekit_api_secret_ciphertext" IS NULL
      AND "livekit_ws_url" IS NULL
      AND "livekit_registered_at" IS NULL
    )
    OR
    (
      "livekit_api_key" IS NOT NULL
      AND "livekit_api_secret_ciphertext" IS NOT NULL
      AND "livekit_ws_url" IS NOT NULL
      AND "livekit_registered_at" IS NOT NULL
    )
  );

-- Scheduler hot read: "any non-revoked node in region X with
-- LiveKit credentials registered". Partial index keyed on the
-- presence of api_key so the JWT mint path can pick a Mac without
-- scanning rows that haven't registered LiveKit yet.
CREATE INDEX "fleet_nodes_livekit_registered_idx"
  ON "fleet_nodes"("region")
  WHERE "revoked_at" IS NULL AND "livekit_api_key" IS NOT NULL;
