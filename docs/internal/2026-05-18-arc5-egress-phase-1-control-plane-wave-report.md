# Arc 5 EGRESS Phase 1 control-plane wave report — 2026-05-18

## Scope

The full Arc 5 EGRESS Phase 1 control-plane wave landed in this
session — 20+ commits closing the eg.1–eg.8 chain across migrations,
schemas, services, repos, routes, OpenAPI, all 3 SDKs, customer
dashboard, admin panel, docs, and drift guards.

Cross-agent boundary: eg.2 (WebSocket control-plane listener that
ingests `egress.capability_report` events from the harness) is the
ONLY remaining piece — gated on Agent 1's harness side per planning
133 §"Phase 1 cross-agent contract". The wave landed the entire
server-side chain so eg.2 only has to call the existing
`SessionsService.ingestEgressCapabilityReport()` method when it
lands.

## Shipped

### eg.1 — migration 0054 + raw payload column

| Sub-slice | Commit     | One-line                                                                                                       |
| --------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| eg.1      | `12c9a367` | Migration 0054 — `sessions.egress_capability_report` jsonb column (raw harness payload alongside derived view) |
| eg.1.b    | `ce3d99c7` | `SessionRepo.setEgressCapabilityReport` method + InMemory impl + Drizzle impl + 4 unit tests                   |
| eg.1.c    | `eec5926a` | Wire surface — extends `SessionSchema` (api-types) + `publicSession()` route serialization                     |
| eg.1.d    | `39103c71` | Regen `packages/sdk-python/openapi.json` so SDK codegen picks up the new field                                 |
| eg.1.e    | `89cae07e` | End-to-end persist→read integration test through the route                                                     |
| eg.1.f    | `0aff7922` | Regen Python `_generated/models.py` via `scripts/generate.sh` codegen                                          |
| eg.1.g    | `4fd47c0c` | Go SDK `Session.EgressCapabilityReport` struct field (Go doesn't use generated models)                         |
| eg.1.g.2  | `00ba838a` | Go SDK unmarshal tests — populated + null wire cases                                                           |
| eg.1.h    | `ee0eeba9` | TS SDK `fakeSession()` fixture catch-up (TS2741)                                                               |
| eg.1.i    | `831e28f0` | Python SDK fixture catch-up (3 files × pydantic_core required-key validation)                                  |
| eg.1.j    | `a67df2aa` | Server-side fixture + 13→14 cardinality invariant catch-up                                                     |
| eg.1.k    | `256bb88a` | `sessions-failure.test.ts` inline SessionRepo fixture catch-up                                                 |
| eg.1.l    | `84821a34` | Admin route `publicSession()` projection adds `egress_capability_report`                                       |

### eg.5 — dashboard + admin warning badge

| Sub-slice | Commit     | One-line                                                               |
| --------- | ---------- | ---------------------------------------------------------------------- |
| eg.5      | `37d87b95` | Customer dashboard active-sessions row — amber `⚠ proxy <count>` badge |
| eg.5.b    | `49f81d6e` | Same badge on recent (closed) sessions row                             |
| eg.5.c    | `0baac249` | Admin panel sessions table — same badge with admin-theme amber-700     |

### eg.6 — cross-source content parity drift guard

| Sub-slice | Commit     | One-line                                                                                            |
| --------- | ---------- | --------------------------------------------------------------------------------------------------- |
| eg.6      | `5db24b85` | 9-assertion cross-source invariant pinning api-types / schema / repo / service / route / migrations |

### eg.7 — webhook event `session.egress_capability_changed`

| Sub-slice | Commit     | One-line                                                                                           |
| --------- | ---------- | -------------------------------------------------------------------------------------------------- |
| eg.7      | `e401b512` | New event type across 5 layers: api-types enum + pgEnum + migration 0055 + service + delivery type |
| eg.7.b    | `e9668206` | Astro docs catalog entry                                                                           |
| eg.7.c    | `9c31fe4a` | W852 cross-source roster: 6 → 7 events + 5 → 6 subscribable; dashboard checkbox add                |
| eg.7.d    | `22fd2641` | Root `docs/api/webhook-events.md` catalog entry + W570.C drift guard pin                           |
| eg.7.e    | `d5f5f2bd` | `SessionsService.ingestEgressCapabilityReport()` — orchestrates persist + best-effort webhook emit |

### eg.8 — V-log + end-to-end smoke

| Sub-slice | Commit        | One-line                                                                                      |
| --------- | ------------- | --------------------------------------------------------------------------------------------- |
| eg.8      | (this commit) | E2E smoke test simulating harness emit → persist → webhook → GET round-trip; this V-log entry |

### SDK CHANGELOG

| Commit     | One-line                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------- |
| `a65e95cf` | `[Unreleased]` entries in TS/Python/Go SDK CHANGELOGs for `Session.egress_capability_report` |

## What landed end-to-end

The full chain in execution order:

1. **Harness emits** `egress.capability_report` event (Agent 1
   side; not yet wired — eg.2 pending)
2. **eg.2 control-plane listener** ingests, validates, calls
   `SessionsService.ingestEgressCapabilityReport()` (pending)
3. **eg.7.e service method** persists via repo + emits webhook:
   - **eg.1.b repo** atomically writes both `egress_capabilities`
     (derived view from migration 0045) AND
     `egress_capability_report` (raw payload from migration 0054)
   - **eg.7 webhook** enqueues `session.egress_capability_changed`
     with `{ session_id, egress_capabilities }` payload
   - **Best-effort emit**: webhook failure doesn't roll back persist
4. **eg.1.c route surface** exposes both fields on
   `GET /v1/sessions/{id}` via `publicSession()` projection
5. **eg.1.l admin route** exposes both fields on
   `GET /v1/admin/sessions` for support staff forensics
6. **SDK consumes**: TS via `z.infer<SessionSchema>` (eg.1.c);
   Python via regenerated `_generated/models.py` (eg.1.f); Go via
   hand-updated `Session.EgressCapabilityReport` (eg.1.g)
7. **Dashboard renders** the `⚠ proxy <count>` warning badge on
   both active (eg.5) and recent (eg.5.b) session lists
8. **Admin panel renders** the same badge on its operator table
   (eg.5.c)

## Test surface delta

| Surface                                                                      | Tests added |
| ---------------------------------------------------------------------------- | ----------: |
| `apps/server/tests/unit/in-memory-sessions-egress-capability-report.test.ts` |           4 |
| `apps/server/tests/unit/sessions-ingest-egress-capability-report.test.ts`    |           4 |
| `apps/server/tests/unit/egress-capabilities-cross-source-invariant.test.ts`  |           9 |
| `apps/server/tests/integration/v1-sessions-egress-capability-report.test.ts` |           2 |
| `apps/server/tests/integration/v1-arc5-egress-end-to-end-smoke.test.ts`      |           4 |
| `apps/server/tests/unit/dashboard-sessions-egress-warning-badge.test.ts`     |           7 |
| `apps/server/tests/unit/admin-panel-sessions-egress-warning-badge.test.ts`   |           4 |
| `packages/sdk-go/types_test.go` (extension)                                  |           2 |
| **Total**                                                                    |      **36** |

Plus fixture + invariant catch-up across 8 pre-existing test files
that now satisfy the new required-key contract.

## Forensics + schema-evolution safety net

The headline value-prop of the eg.1 raw-vs-derived split: customer-
supplied SOCKS5 proxies can fail in many ways (UDP ASSOCIATE
unsupported, DOMAINNAME ATYP unsupported, MTU mismatch, etc.). The
derived view exposes the known shape (`udp_associate`,
`quic_route`, `dns_remote_resolve`, `warnings[]`) for SDK-typed
access. The raw payload preserves whatever extra fields the
harness emits — e.g. `harness_diagnostic: { rtt_ms, hop_count,
fork_pid }` — without requiring an SDK release.

The eg.8 smoke specifically asserts a `harness_diagnostic` field
survives the round-trip via the raw column, proving the schema-
evolution promise end-to-end.

## Outstanding (next session)

- **eg.2 WebSocket control-plane listener** — only remaining piece
  of the Arc 5 Phase 1 wave; gated on Agent 1 harness side per
  planning 133 §"Phase 1 cross-agent contract"
- **Wave 2.C GUI integration** — Next.js components for
  AgentSessionPanel + TakeoverHandbackButtons + TranscriptStream
  - ModeSelector + BundledLlmStatusPanel (load-bearing for v1.0
    launch differentiator per founder verdict 2026-05-17)
- **Wave 2.D end-to-end Cypress/Playwright smoke** for the 3
  pair-mode flows
- **Arc 6 remaining docs + Arc 7 remaining obs**
