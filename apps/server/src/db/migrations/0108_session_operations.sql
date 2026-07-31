-- Durable direct-operation resource, slice 1 (schema + fences; no route yet).
-- Design: docs/internal/durable-direct-operation-design.md.
--
-- Direct login/search runs to a 600,000 ms producer wall, which no default
-- public path survives: nginx `location /` cuts at 60 s, the proxied edge at
-- ~100-120 s, the TS SDK at 30 s. The producer is not the problem, the RESPONSE
-- is -- and a client that disconnects mid-flight leaves a credential submission
-- outcome-unknown, the one state we may never resolve by retrying. So the
-- outcome becomes a row that outlives the connection.
--
-- All three concurrency fences live HERE rather than in process memory, because
-- a fence held in one process is not a fence across restarts or instances.

CREATE TABLE "session_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  -- Binds the operation to ONE driver lifetime. A settled result must never be
  -- applied to a successor session that reused the driver id -- mock-driver id
  -- reuse across restart is a recorded defect, not a hypothetical.
  "driver_incarnation_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  -- sha256 of the Idempotency-Key header; the raw key is never stored.
  "idempotency_key_hash" text,
  -- sha256 over the canonicalised request body. Same key + different
  -- fingerprint is a 409, mirroring crypto_orders.
  "request_fingerprint" text NOT NULL,
  "result" jsonb,
  "error" jsonb,
  -- accepted_at + the SAME 600,000 ms producer constant. The API must not
  -- invent its own number.
  "deadline_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "settled_at" timestamp with time zone,
  "result_expires_at" timestamp with time zone,

  CONSTRAINT "session_operations_kind" CHECK ("kind" IN ('login', 'search')),
  CONSTRAINT "session_operations_status" CHECK (
    "status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')
  ),
  CONSTRAINT "session_operations_idempotency_key_hash_shape"
    CHECK ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_operations_request_fingerprint_shape"
    CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),

  -- Terminal shape. `succeeded` is the ONLY status that may carry a result, and
  -- `failed` the only one that may carry an error; every terminal must be
  -- stamped, and no live row may be. Cancelled/expired carry neither payload:
  -- an expired operation has no outcome to report, which is the point.
  CONSTRAINT "session_operations_terminal_shape" CHECK (
    ("status" IN ('queued', 'running')
      AND "result" IS NULL AND "error" IS NULL
      AND "settled_at" IS NULL AND "result_expires_at" IS NULL)
    OR
    ("status" = 'succeeded'
      AND "error" IS NULL
      AND "settled_at" IS NOT NULL)
    OR
    ("status" = 'failed'
      AND "result" IS NULL
      AND "settled_at" IS NOT NULL)
    OR
    ("status" IN ('cancelled', 'expired')
      AND "result" IS NULL AND "error" IS NULL
      AND "settled_at" IS NOT NULL)
  ),

  -- Retention (§7) is measured from settlement, so it can never precede it.
  CONSTRAINT "session_operations_retention_after_settlement"
    CHECK ("result_expires_at" IS NULL OR "settled_at" IS NULL OR "result_expires_at" >= "settled_at")
);

-- FENCE 1 (admission). At most one LIVE operation per session, so a session can
-- never have two direct operations in flight. Partial, so the many settled rows
-- of a long-lived session do not collide -- history is unbounded, liveness is
-- exclusive. Admission inserts ON CONFLICT DO NOTHING and reads zero rows as
-- "already owned" -> 409.
CREATE UNIQUE INDEX "session_operations_one_live_per_session"
  ON "session_operations" ("session_id")
  WHERE "status" IN ('queued', 'running');

-- FENCE 2 (idempotency). A retry after a disconnect must return the SAME
-- operation rather than submitting a second set of credentials. Scoped to the
-- account so one customer's key can never collide with another's, and partial
-- so key-less operations do not all collide on a shared NULL.
CREATE UNIQUE INDEX "session_operations_account_idempotency_key"
  ON "session_operations" ("account_id", "idempotency_key_hash")
  WHERE "idempotency_key_hash" IS NOT NULL;

-- FENCE 3 (terminal CAS) is a WHERE clause on every terminal UPDATE
-- (`... AND status = 'running' AND driver_incarnation_id = $incarnation`)
-- rather than an index. It needs no schema object; it needs the incarnation
-- column above, which is why that column is NOT NULL.

-- Ownership is checked on every read, and the retention sweeper scans by
-- expiry, so both get an index.
CREATE INDEX "session_operations_account_created_idx"
  ON "session_operations" ("account_id", "created_at");
CREATE INDEX "session_operations_result_expiry_idx"
  ON "session_operations" ("result_expires_at")
  WHERE "result_expires_at" IS NOT NULL;
