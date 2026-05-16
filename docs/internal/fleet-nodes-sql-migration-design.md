# V-820 — `fleet_nodes` SQL migration design (Tier-2 proposal)

**Status:** DESIGN for founder review (per AGENTS.md / planning Tier-2:
"spec changes, scope adjustments, architecture changes, vendor changes
... treat as Tier 2 and propose"). Migration NOT landed; SHIPPED so
far is the JWT verifier primitive + `InMemoryFleetNodesRepo` (commit
`95353f2a`).

**Why:** `FleetNodeAuthImpl` consumes `FleetNodesRepo.getPublicKey(nodeId)`.
The in-memory variant covers tests + dev mode. Production needs Postgres
backing so the founder can revoke a compromised fleet node without
restarting the control plane, and so `nodeId → publicKey` survives
deploys. The `/v1/fleet/events` WebSocket route + Agent 1's V-820.B.1.b
mTLS endpoint dependency both wait this migration.

**Source of truth:** `docs/network-architecture.md` §"v1 design — signed
JWT over mTLS" describes the auth flow but doesn't prescribe the table
shape. This doc proposes the shape; founder review accepts or revises;
then the migration lands as a separate slice.

---

## Proposed table shape

```sql
CREATE TABLE fleet_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity (registered at node provisioning):
  public_key_base64url text NOT NULL,
  -- Base64url-encoded 32-byte Ed25519 public key (44 chars including
  -- the trailing '=' padding per RFC 4648 §5). UNIQUE because two nodes
  -- sharing a keypair would defeat per-node revocation.
  CONSTRAINT fleet_nodes_public_key_format CHECK (
    public_key_base64url ~ '^[A-Za-z0-9_-]{43}=$'
  ),
  CONSTRAINT fleet_nodes_public_key_unique UNIQUE (public_key_base64url),

  -- Metadata:
  display_name text NOT NULL,
  -- Human-readable name for the fleet dashboard ("mac-studio-01",
  -- "mac-mini-eu-west-3", etc.). Operator-set at provisioning.
  region text NOT NULL,
  -- e.g. 'eu-central-1', 'us-east-1'. Indexes the EGRESS scheduler.
  hardware_class text NOT NULL,
  -- 'mac-mini-m4', 'mac-studio-m3-ultra', 'mac-studio-m4-ultra', etc.
  -- Drives VM-density planning per planning 133 Tier-3 verdict #4
  -- (5-10 pre-warmed VMs per Mac Studio M3 Ultra).

  -- Lifecycle:
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NULL,
  -- Updated each successful authenticated connect. Operator dashboard
  -- shows "X minutes ago" so dead nodes are visible.
  revoked_at timestamptz NULL,
  -- Set when the operator marks the node revoked. FleetNodeAuthImpl
  -- already returns 'revoked_node' when this is non-null. Revocation
  -- is soft (row preserved) so audit trails survive.
  revocation_reason text NULL
  -- Operator-supplied; surfaces in fleet dashboard + admin audit log.
);

CREATE INDEX fleet_nodes_region_idx ON fleet_nodes(region) WHERE revoked_at IS NULL;
CREATE INDEX fleet_nodes_last_seen_at_idx ON fleet_nodes(last_seen_at DESC) WHERE revoked_at IS NULL;
```

**Index rationale:**

- `region` partial index — scheduler selects "any non-revoked node in
  region X" frequently; partial index keeps it small.
- `last_seen_at DESC` partial index — dashboard sorts "most-recently-
  seen first" + alerts on dead nodes (LRU dead-node query).

**Choices that need founder input:**

1. **`public_key_base64url` as the natural key vs UUID id.** Proposed
   UUID id + UNIQUE on public_key. Alternative: public_key IS the id
   (PK), no separate UUID. UUID id wins on: clean foreign keys, easier
   to talk about ("node 7f3a..." vs the 44-char base64), audit log
   correlation. Public-key-as-PK wins on: one fewer column, no
   duplication. Founder verdict?

2. **`region` enum vs free-form text.** Proposed text. The set of
   regions is small + operator-controlled (currently US + EU at
   launch), but Postgres CHECK constraint feels too rigid for an
   operational table. Founder verdict?

3. **Foreign keys from sessions / usage_events to fleet_nodes.**
   Proposed NONE for now — the session record carries `fleet_node_id`
   as a denormalized FK once a session is assigned, and `usage_events`
   carries the same for billing attribution. Founder verdict on the
   FK direction?

4. **Revocation cascade.** When a node is revoked, do we keep its
   `fleet_node_id` references in sessions / usage_events (audit
   value preserved) or NULL them (clean up "this node never
   existed")? Proposed: keep, with `revoked_at` indicating the
   relationship's lifecycle.

5. **`hardware_class` enum vs text.** Same as `region` — proposed
   text + operator-driven; alternative is a CHECK against an
   enum that gates VM-density logic.

---

## Bootstrap wiring (proposed; lands with the migration)

```ts
// apps/server/src/lib/bootstrap.ts (sketch)
const fleetNodesRepo: FleetNodesRepo = new DrizzleFleetNodesRepo(dbHandle);
const fleetNodeAuth: FleetNodeAuth = new FleetNodeAuthImpl(fleetNodesRepo);

// AppDeps:
//   fleetNodeAuth?: FleetNodeAuth;
//   fleetNodesRepo?: FleetNodesRepo;
// Future /v1/fleet/* routes read both (activation-gated; 503 stub
// when omitted, mirroring billing + EGRESS + agent-sessions).
```

The `DrizzleFleetNodesRepo` shape is mechanical given the table —
`drizzle-orm` query + Date conversions for `last_seen_at` /
`revoked_at` / `registered_at`. Estimated <100 LOC + a unit test
that exercises register / revoke / getPublicKey + the revoked-after-
registered path.

---

## Operator surface (post-migration follow-up slices)

- `POST /v1/admin/fleet-nodes` — register a new node (operator-only
  scope; auditable).
- `GET /v1/admin/fleet-nodes` — list with last_seen_at sort.
- `POST /v1/admin/fleet-nodes/{id}/revoke` — soft-delete; reason
  required for audit.
- `GET /v1/admin/fleet-nodes/{id}` — single node detail (last seen,
  recent session count, revocation status).

Customer surface: NONE. Fleet topology is operator-only; customers
see only the session-routing-result + region tag via existing
`/v1/sessions` shape.

---

## Migration plan (lands as separate slice after founder review)

1. Write `apps/server/src/db/migrations/<timestamp>-add-fleet-nodes-table.sql`
   matching the shape above.
2. Update `_journal.json` (per V-228 backstop in `.husky/pre-push`).
3. Add Drizzle schema entry in `apps/server/src/db/schema.ts`.
4. Implement `DrizzleFleetNodesRepo` against the new table.
5. Wire into `bootstrap.ts` per the sketch above.
6. Unit test + integration test exercise.

Total estimated landing scope: ~150 LOC + 2 tests, single commit
after founder approval.

---

## What this design does NOT cover (separate slices)

- Operator dashboard UI for fleet nodes (admin-panel route + page).
- Nonce cache for JWT replay defense (Redis-backed; trivial extension
  once `FleetNodeAuthImpl` has the repo wired).
- mTLS layer at Cloudflare Authenticated Origin Pulls (infra, not API).
- `/v1/fleet/events` WebSocket route (lands after this table; binds
  Agent 1's V-820.B.1.b dependency).
- Fleet metrics (per-node session count, VM pool utilization).
