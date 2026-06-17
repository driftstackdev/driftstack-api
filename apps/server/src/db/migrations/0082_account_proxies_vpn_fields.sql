-- 2026-06-17 — OVPN/WG arc slice 1: extend account_proxies to carry VPN configs.
-- account_proxies (0081) stored only socks5/http: host/port/username/wrapped_password.
-- OpenVPN/WireGuard proxies carry (a) a SECRET payload — the .ovpn config_blob
-- (embeds certs/keys) or the WireGuard private_key — and (b) NON-secret structured
-- fields (WireGuard peer_public_key/endpoint/allowed_ips/dns, OpenVPN username).
-- This adds:
--   wrapped_secret — TMK-wrapped secret payload, base64([iv|tag|ct]) exactly like
--                    wrapped_password (lib/profile-key-hierarchy wrapAccountSecret);
--                    NEVER stored/returned in plaintext. NULL for socks5/http rows.
--   config         — jsonb of the non-secret structured VPN fields. '{}' for
--                    socks5/http rows.
-- The proxy TYPE discriminator reuses the existing `scheme` text column (widened
-- app-side to socks5|http|openvpn|wireguard — it has no DB enum constraint, so no
-- migration is needed for the new values). Additive + idempotent + behavior-identical
-- until the VPN write path (a later API slice) populates these; no backfill.
ALTER TABLE "account_proxies" ADD COLUMN IF NOT EXISTS "wrapped_secret" text;
ALTER TABLE "account_proxies" ADD COLUMN IF NOT EXISTS "config" jsonb NOT NULL DEFAULT '{}'::jsonb;
