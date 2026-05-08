-- V-352 — account timezone (IANA name) for customer-local timestamp
-- rendering in the dashboard + outbound emails. Nullable; defaults to
-- UTC display when unset.

ALTER TABLE "accounts" ADD COLUMN "timezone" text;
