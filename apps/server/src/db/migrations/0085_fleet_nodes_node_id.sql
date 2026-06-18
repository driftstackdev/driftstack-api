-- 2026-06-18 — fleet-node identity: human-readable node_id.
--
-- The harness daemon's JWT `iss` (= DRIFTSTACK_MAC_NODE_ID, set from the
-- bring-up config.env NODE_ID, e.g. "mac-macstadium-us-001") is a HUMAN string,
-- but auth resolved the node by `fleet_nodes.id` (a uuid) — a non-uuid iss
-- against a uuid column fails (the W2203b mismatch, confirmed against the live
-- box). Adds `node_id text` as the stable human identity the harness signs as;
-- auth/heartbeat now key by it (FleetNodeAuth.getPublicKey + recordHeartbeat),
-- so a node connects with its natural config.env NODE_ID — no box reconfig.
--
-- Partial UNIQUE (WHERE node_id IS NOT NULL) so existing identity-less rows
-- (none in prod — fleet_nodes is empty) don't collide, while two real nodes
-- can't share an id. The uuid `id` stays the internal primary key. Additive +
-- idempotent; no backfill.
ALTER TABLE "fleet_nodes" ADD COLUMN IF NOT EXISTS "node_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_nodes_node_id_unique"
  ON "fleet_nodes" ("node_id") WHERE "node_id" IS NOT NULL;
