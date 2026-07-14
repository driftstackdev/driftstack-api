-- Durable at-most-once receipts for POST /v1/agent-sessions/:id/message.
-- Browser work deliberately continues when an SSE viewer disconnects; a
-- caller-reused Idempotency-Key must therefore replay the terminal result
-- instead of executing a second browser turn.
CREATE TABLE "agent_turn_receipts" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "agent_session_id" text NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
  "request_hash" text NOT NULL,
  "state" text NOT NULL,
  "response_status" integer,
  "response_ciphertext" bytea,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_turn_receipts_pk" PRIMARY KEY ("account_id", "idempotency_key"),
  CONSTRAINT "agent_turn_receipts_key_length" CHECK (length("idempotency_key") BETWEEN 1 AND 255),
  CONSTRAINT "agent_turn_receipts_request_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "agent_turn_receipts_state" CHECK ("state" IN ('in_progress', 'completed')),
  CONSTRAINT "agent_turn_receipts_terminal_shape" CHECK (
    ("state" = 'in_progress' AND "response_status" IS NULL AND "response_ciphertext" IS NULL AND "completed_at" IS NULL)
    OR
    ("state" = 'completed' AND "response_status" BETWEEN 100 AND 599 AND "response_ciphertext" IS NOT NULL AND "completed_at" IS NOT NULL)
  )
);

CREATE INDEX "agent_turn_receipts_session_created_idx"
  ON "agent_turn_receipts" ("agent_session_id", "created_at");
