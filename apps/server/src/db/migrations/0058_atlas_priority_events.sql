-- Wave 29-400 §8.1 — atlas_priority_events table.
--
-- Auto-learn pipeline observability surface: each Mac-fork-emitted probe
-- signature gets a row that tracks its lifecycle from harvester emit
-- through BS Automate run through atlas append (or failure at any step).
-- Source of truth for the admin /atlas-priority-queue page (§8.3) and
-- the internal POST /v1/internal/atlas-priority/* endpoints (§8.2).
--
-- Lifecycle: emitted → queued → bs_in_flight → bs_succeeded → atlas_appended
--                                            ↘ bs_failed (terminal)
--                                              ↘ atlas_failed (terminal)
--
-- Per the §1b2001c8 drizzle-orm 0.38.4 Date-param workaround memory rule,
-- all timestamp columns are timestamptz; the DrizzleAtlasPriorityEvents
-- Repo writes will pre-serialize Date params to ISO strings in any raw
-- sql template literal (table-builder API is unaffected).
--
-- Dedup: same op_seq_sha + archetype_id within 5 min coalesces to one
-- row. Hard-enforced at the UNIQUE constraint via the emitted_at column
-- truncated to a 5-min bucket (no DB-side computed-column trickery —
-- the dedup check is done at insert time by the service layer instead;
-- the UNIQUE constraint here is the (op_seq_sha, archetype_id, emitted_at)
-- triple, which prevents EXACT-millisecond dupes but lets the service
-- enforce the soft 5-min window).

CREATE TABLE "atlas_priority_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "op_seq_sha" text NOT NULL,
  "op_seq_bytes_b64" text NOT NULL,
  "canvas_w" integer NOT NULL,
  "canvas_h" integer NOT NULL,
  "mime" text NOT NULL,
  "archetype_id" text NOT NULL,
  "last_fill_text" text,
  "mac_len" integer,
  "session_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "page_url" text NOT NULL,
  "status" text NOT NULL CHECK (
    "status" IN (
      'emitted',
      'queued',
      'bs_in_flight',
      'bs_succeeded',
      'bs_failed',
      'atlas_appended',
      'atlas_failed'
    )
  ),
  "emitted_at" timestamptz NOT NULL DEFAULT now(),
  "bs_automate_session_id" text,
  "bs_started_at" timestamptz,
  "bs_completed_at" timestamptz,
  "bs_error_reason" text,
  "atlas_entry_hash" text,
  "atlas_version" text,
  "atlas_appended_at" timestamptz,
  "atlas_error_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "atlas_priority_events_dedup_triple_unique"
    UNIQUE ("op_seq_sha", "archetype_id", "emitted_at")
);

CREATE INDEX "atlas_priority_events_status_emitted_at_idx"
  ON "atlas_priority_events" ("status", "emitted_at" DESC);

CREATE INDEX "atlas_priority_events_customer_emitted_at_idx"
  ON "atlas_priority_events" ("customer_id", "emitted_at" DESC);

CREATE INDEX "atlas_priority_events_session_id_idx"
  ON "atlas_priority_events" ("session_id");
