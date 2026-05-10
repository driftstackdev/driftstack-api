-- V-481 — granular per-resource API key scopes (Phase 1 schema).
--
-- Existing scopes (`read`, `write`, `admin`, `account_owner`,
-- `driftstack_internal_admin`, `gui_control`) stay unchanged so old
-- keys keep working.
--
-- New granular values follow `verb:resource` order matching the
-- founder direction. Customers can mint a narrower-scoped key (e.g.
-- a key with only `read:sessions` for a monitoring integration).
--
-- Phase 1 lands the schema + helper backwards-compat (broad satisfies
-- granular) + dashboard UI for minting granular keys. Phase 2
-- narrows service-layer enforcement so granular keys actually limit
-- access (today the service layer still calls
-- `requireScope('account_owner')` etc., which broad keys satisfy).
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'read:sessions';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'write:sessions';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'read:profiles';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'write:profiles';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'admin:profiles';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'read:webhooks';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'write:webhooks';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'admin:webhooks';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'read:api-keys';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'admin:api-keys';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'read:billing';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'admin:billing';
ALTER TYPE "api_key_scope" ADD VALUE IF NOT EXISTS 'read:audit';
