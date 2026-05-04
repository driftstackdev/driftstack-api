-- V-154: rename archetype DEFAULT from old 'iphone16pro_ios26_4_1'
-- (incorrect framing — Apple ships Safari independently of iOS major,
-- so packing iOS-only versioning into the slug was misleading) to
-- 'iphone16pro_ios18_7_safari26_4' (matches LOCKED_ARCHETYPE_ID in
-- packages/api-types/src/common.ts; see V-136 for the customer-facing
-- copy migration + docs/architecture/archetype-naming-convention.md
-- for the identifier shape rationale).
--
-- Existing rows with the old default value are NOT migrated — they
-- represent historical state at the time of insert and the
-- driver-layer interpretation of the string is the same archetype
-- (the underlying device + browser engine binary is identical).
-- This migration changes only the column DEFAULT used by future
-- INSERT ... DEFAULT queries.

ALTER TABLE "profiles" ALTER COLUMN "archetype" SET DEFAULT 'iphone16pro_ios18_7_safari26_4';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "archetype" SET DEFAULT 'iphone16pro_ios18_7_safari26_4';
