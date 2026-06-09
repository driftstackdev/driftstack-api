-- Profile-backed sessions (planning file 57 key hierarchy): per-profile wrapped DEK.
-- Additive + nullable — existing rows + non-DEK profiles stay NULL; non-breaking.
-- Stores base64([iv|tag|ciphertext]) of the per-profile DEK wrapped under the
-- account's TMK (see lib/profile-key-hierarchy.ts). The plaintext DEK is never
-- stored; it is unwrapped on demand at session-assign time.
ALTER TABLE "profiles" ADD COLUMN "wrapped_dek" text;
