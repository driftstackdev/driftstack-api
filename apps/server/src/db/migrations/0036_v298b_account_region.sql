-- V-298b — Stripe-style data-residency region preference.
-- Customer-stated; currently informational (actual physical region
-- routing of compute / storage governed by the DPA Annex 3 sub-
-- processor list). Null = unset.
CREATE TYPE "account_region" AS ENUM ('us', 'eu', 'apac');
ALTER TABLE "accounts" ADD COLUMN "region" "account_region";
