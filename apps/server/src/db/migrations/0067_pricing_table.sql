-- 2026-06-04 — pricing-as-data Phase A: owner-editable per-tier monthly price.
-- A DB source-of-truth for the internal $ values (the PricingService falls back
-- to the TIER_MONTHLY_PRICE_CENTS constant when a tier row is absent). SEEDED
-- here from the current constants so the DB equals the constants on day one and
-- nothing changes until the owner edits a price. Additive; no data loss. The
-- 6 paid tiers only (free = 0, enterprise = sales-negotiated, neither self-serve
-- priced). Hand-authored per the established migration workflow (the drizzle-kit
-- snapshot is frozen at 0022; td-002 tracks reinstatement).
CREATE TABLE IF NOT EXISTS "pricing" (
	"tier" "account_tier" PRIMARY KEY NOT NULL,
	"monthly_cents" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_key_id" uuid
);
--> statement-breakpoint
INSERT INTO "pricing" ("tier", "monthly_cents") VALUES
	('solo_manual', 7900),
	('team_manual', 24900),
	('agency_manual', 69900),
	('api_starter', 14900),
	('api_builder', 49900),
	('api_scale', 149900)
ON CONFLICT ("tier") DO NOTHING;
