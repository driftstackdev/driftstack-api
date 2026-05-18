-- Arc 2 sub-slice 8.1 (v2-#8 AI chat + manual side-by-side).
--
-- Founder verdicts locked 2026-05-18:
--   Q1=A SSE for live transcript (no schema change here; route layer)
--   Q2=C 24h-TTL gui_control_key auto-minted at session create
--   Q3=A pair_mode_state as a JSONB column on agent_sessions
--   Q4=A route-layer Redis lock for takeover contention
--   Q5=A hide cost (mirrors v2-#6 Q5)
--
-- Three columns on `agent_sessions`:
--
--   pair_mode_state JSONB DEFAULT NULL
--     Sub-slice 8.7 state machine writes here. NULL = "no pair state"
--     (mode is either manual or ai). Set to the discriminator object
--     (e.g. {kind: 'ai-driving'} | {kind: 'takeover-pending', …})
--     when mode='pair'. JSONB lets the state machine evolve without
--     further migrations.
--
--   gui_control_key_expires_at TIMESTAMPTZ NULL
--     Sub-slice 8.4 mints the gui_control_key plaintext at session
--     create + stores its expiry here (24h TTL per Q2=C). The
--     plaintext is encrypted into gui_control_key_ciphertext (added
--     in this migration too). NULL when no key was minted.
--
--   gui_control_key_ciphertext BYTEA NULL
--     Encrypted plaintext (AES-GCM via MFA_ENCRYPTION_KEY pattern,
--     same crypto as v2-#21 BYOK Anthropic). Cleared on session
--     close.
--
--   mode TEXT NOT NULL DEFAULT 'ai' CHECK ('manual'|'ai'|'pair')
--     Existing rows pick up 'ai' (the v2-#19 baseline default) so
--     no backfill is needed. Customer + SDK pick 'manual' or 'pair'
--     at create-time via the SDK's mode option (sub-slice 8.5).

ALTER TABLE "agent_sessions"
  ADD COLUMN "pair_mode_state" jsonb,
  ADD COLUMN "gui_control_key_expires_at" timestamptz,
  ADD COLUMN "gui_control_key_ciphertext" bytea,
  ADD COLUMN "mode" text NOT NULL DEFAULT 'ai'
    CHECK ("mode" IN ('manual', 'ai', 'pair'));
