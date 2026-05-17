-- V-820 fleet_nodes table — design APPROVED AS WRITTEN 2026-05-17
-- (orchestrator handoff post-AUTO #1; design source of truth
-- docs/internal/fleet-nodes-sql-migration-design.md).
--
-- Backs FleetNodeAuthImpl's `FleetNodesRepo.getPublicKey(nodeId)` lookup
-- in production. The in-memory variant (`InMemoryFleetNodesRepo` in
-- services/fleet-node-auth.ts) covers tests + dev; this migration
-- lands the prod backing.
--
-- Once this lands:
--   - DrizzleFleetNodesRepo wires into bootstrap.ts (separate slice).
--   - /v1/fleet/events activation gate (ae670c80) starts checking
--     `deps.fleetNodeAuth + deps.fleetNonceCache` against real Postgres.
--   - Agent 1's V-820.B.1.b mTLS endpoint can register its first
--     production fleet node and verify the auth path end-to-end.

CREATE TABLE "fleet_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (registered at node provisioning):
  --
  -- Base64url-encoded 32-byte Ed25519 public key — 43 base64url chars
  -- + 1 '=' pad per RFC 4648 §5 = 44 total. UNIQUE because two nodes
  -- sharing a keypair would defeat per-node revocation.
  "public_key_base64url" text NOT NULL,
  CONSTRAINT "fleet_nodes_public_key_format" CHECK (
    "public_key_base64url" ~ '^[A-Za-z0-9_-]{43}=$'
  ),
  CONSTRAINT "fleet_nodes_public_key_unique" UNIQUE ("public_key_base64url"),

  -- Metadata (operator-set at provisioning):
  --
  -- display_name = human-readable fleet identifier ("mac-studio-01",
  --                "mac-mini-eu-west-3", …).
  -- region       = e.g. 'eu-central-1', 'us-east-1'. Indexes the
  --                EGRESS scheduler.
  -- hardware_class = e.g. 'mac-mini-m4', 'mac-studio-m3-ultra'.
  --                  Drives VM-density planning per planning 133
  --                  Tier-3 verdict #4 (5-10 pre-warmed VMs per
  --                  Mac Studio M3 Ultra).
  --
  -- Founder verdict (orchestrator handoff 2026-05-17): both `region`
  -- + `hardware_class` are free-form text (NO Postgres CHECK enum).
  -- Operator-controlled set; CHECK enum feels too rigid for the
  -- operational table.
  "display_name" text NOT NULL,
  "region" text NOT NULL,
  "hardware_class" text NOT NULL,

  -- Lifecycle:
  --
  -- registered_at — server clock at registration; immutable.
  -- last_seen_at  — bumped on each successful authenticated connect.
  --                 NULL until the node first authenticates. Operator
  --                 dashboard shows "X minutes ago" so dead nodes are
  --                 visible.
  -- revoked_at    — set when the operator marks the node revoked.
  --                 FleetNodeAuthImpl already returns 'revoked_node'
  --                 when this is non-null. Soft delete; the row stays
  --                 so audit trails survive (founder verdict Q4 —
  --                 keep, don't NULL the FK from sessions/usage_events).
  -- revocation_reason — operator-supplied free-form; surfaces in
  --                 fleet dashboard + admin audit log.
  "registered_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NULL,
  "revoked_at" timestamptz NULL,
  "revocation_reason" text NULL
);

-- Scheduler hot read: "any non-revoked node in region X". Partial
-- index keeps it small (skips revoked rows).
CREATE INDEX "fleet_nodes_region_idx" ON "fleet_nodes"("region")
  WHERE "revoked_at" IS NULL;

-- Dashboard hot read: "most-recently-seen first" + alerts on dead
-- nodes (LRU dead-node query). Partial again — revoked rows don't
-- show up in the live-fleet view.
CREATE INDEX "fleet_nodes_last_seen_at_idx" ON "fleet_nodes"("last_seen_at" DESC)
  WHERE "revoked_at" IS NULL;
