-- V-312 — profile snapshots. Immutable point-in-time copy of a
-- profile's metadata + state. Parent profile keeps evolving
-- independently; the snapshot is frozen.
CREATE TABLE "profile_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "parent_profile_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL,
  "label" text NOT NULL,
  "description" text,
  "parent_archetype" text NOT NULL,
  "parent_name" text NOT NULL,
  "state_blob" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "captured_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "profile_snapshots_account_idx" ON "profile_snapshots" ("account_id");
CREATE INDEX "profile_snapshots_parent_idx" ON "profile_snapshots" ("parent_profile_id");
