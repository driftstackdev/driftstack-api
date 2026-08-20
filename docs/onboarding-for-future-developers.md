# Onboarding for future developers

> **Audience:** future contributors (including future-you in 6 months when you've forgotten the local-dev steps).
> **Last refresh:** 2026-05-03 (V-102).

This doc is the one-stop "how do I get this running locally + what's the dev loop" reference. The repo is a single TypeScript monorepo with multiple workspaces (Astro marketing site, Astro customer dashboard, Tauri GUI client, Fastify control plane, several SDKs).

If you're reading this with prior context on Driftstack, you can probably skip this doc — `npm install && npm run dev` does most of what you need. Read on if any step doesn't work or if you want the why behind the layout.

## Prerequisites

| Tool           | Version        | Notes                                                                                 |
| -------------- | -------------- | ------------------------------------------------------------------------------------- |
| Node.js        | 22 LTS         | `.nvmrc` pins this. Use `nvm use` or fnm. Newer Node 25.x works for local dev too.    |
| npm            | 10+            | Bundled with Node. We use npm workspaces; do not switch to pnpm/yarn.                 |
| Docker         | 4.x+           | For Postgres 17 + Redis 7 dev infra (`docker-compose.yml`).                           |
| Rust toolchain | optional       | Only if touching the GUI client (Tauri). `rustup` + the platform's WebKit / WebView2. |
| Python         | 3.11+ optional | Only if touching the Python SDK (`packages/sdk-python/`).                             |

## First-run setup

```bash
git clone https://github.com/driftstackdev/driftstack-api.git
cd driftstack-api
nvm use                    # or fnm use
npm install                # installs across all workspaces
docker compose up -d       # boots Postgres + Redis
npm run db:migrate         # applies Drizzle migrations
npm run db:seed            # seeds a dev account + API key
```

Expected output of seed: a printed plaintext API key starting `ds_test_…`. Save it; the dev server uses it for `Authorization: Bearer <key>` headers in your local browser tabs.

## Daily dev loop

```bash
# Run the server with hot-reload (tsx watch).
npm run dev

# Run the marketing site (separate terminal).
npm run dev --workspace apps/marketing-site
# → http://localhost:4321

# Run the customer dashboard (separate terminal).
npm run dev --workspace apps/customer-dashboard
# → http://localhost:5173

# Run the GUI client (separate terminal; only if touching it).
npm run dev --workspace apps/gui-client
```

The control plane defaults to `http://localhost:3000`. OpenAPI spec at `/openapi.json`, Swagger UI at `/docs`.

## Verification chain

Run these before committing any change. The CI pipeline runs them too; if they pass locally they'll pass in CI.

```bash
npm run typecheck     # strict TS + Astro check across all 6 workspaces
npm run lint          # eslint with type-aware rules
npm run format:check  # prettier (use `npm run format` to fix)
npm test              # vitest unit + integration (~6-8s for 478 tests)
npm run build         # tsc --build all workspaces
```

For e2e tests against real Postgres + Redis (Playwright suite):

```bash
docker compose up -d                  # needs the dev services running
npm run test:e2e --workspace apps/server
```

E2E tests are slower (~30-60s) and run with `workers: 1` because the test database is shared. They DROP and re-create the public schema at test-suite start, so they're hermetic.

## Repository layout (one-liner per directory)

```
apps/server/             — Fastify API + control plane (the main app)
apps/marketing-site/     — Astro static site → driftstack.dev
apps/customer-dashboard/ — Astro static site → app.driftstack.dev (V-099 scaffolding)
apps/gui-client/         — Tauri desktop client for end-users
packages/api-types/      — Public Zod schemas + inferred TS types (single source of truth)
packages/sdk-typescript/ — @driftstack/sdk (TypeScript)
packages/sdk-python/     — Python SDK (generated from OpenAPI + hand-polished)
packages/sdk-go/         — Go SDK (planned)
docs/                    — architecture, decisions, V-log, ADRs, deployment, legal
infra/                   — Hetzner provisioning + deploy scripts (when present)
perf/                    — perf harness (autocannon scenarios)
```

The full layout description with intent per file lives in `docs/architecture.md`. Read that doc when you're confused about where something belongs.

## How the codebase makes decisions

Three docs you'll consult:

- **`docs/decisions.md`** — D-NNN entries. Every architectural decision (vendor choice, schema shape, naming convention) is recorded here. When in doubt about why something is a certain way, search this doc first.
- **`docs/verification-log.md`** — V-NNN entries. Append-only empirical log of every substantive change. Pairs with each commit's V-NNN tag in its message. The "next" section at the end usually tells you what's coming.
- **`docs/adr/`** — long-form ADRs for architectural deviations from the planned approach. Read these when working in their domain (ADR-001 hosting, ADR-002 Stripe-only, ADR-003 trial pack, ADR-004 two-ladder pricing, ADR-005 observability draft, ADR-006 audit retention draft).

AGENTS.md at the repo root captures the full operational discipline: test standards, marketing-copy review cadence, decision-authority levels (Routine / Architectural / Contractual), commit pattern (push-to-main with V-NNN tag), what's in scope vs out of scope.

## Common things you might want to do

### Add a new database column

1. Edit `apps/server/src/db/schema.ts` — add the column with the right Drizzle type.
2. Drop a hand-written SQL migration in `apps/server/src/db/migrations/NNNN_descriptive_name.sql`. (drizzle-kit auto-generation is broken on the current version mismatch — see V-088 commentary; hand-roll for now.)
3. Update `apps/server/src/db/migrations/meta/_journal.json` with the new entry.
4. `npm run db:migrate` to apply locally.
5. If exposed via API, add Zod schema to `packages/api-types/`.

### Add a new endpoint

1. Add request/response Zod schemas to `packages/api-types/`.
2. Add service-level method to `apps/server/src/services/<resource>.ts` (with repo interface extension if needed).
3. Add Drizzle implementation (`apps/server/src/db/<resource>-repo.ts`) and in-memory implementation (`apps/server/tests/integration/_helpers/in-memory-<resource>-repo.ts`).
4. Add route handler to `apps/server/src/routes/<resource>.ts` (or extend an existing file).
5. Wire into `apps/server/src/lib/app.ts` (`AppDeps` + route registration) and `apps/server/src/lib/bootstrap.ts` (production wiring).
6. Wire into `apps/server/tests/integration/_helpers/build-test-app.ts` for tests.
7. Write integration tests at `apps/server/tests/integration/<resource>.test.ts`.

The pattern repeats: `auth-flows.ts` (V-079), `profiles.ts` (V-081), `billing.ts` (V-082), `stripe-webhooks.ts` (V-080) are all examples to crib from.

### Add a new admin endpoint

Same as above plus:

- Add the action label to `admin_audit_action` Postgres enum (write a migration; use `ALTER TYPE ... ADD VALUE IF NOT EXISTS` per V-100's pattern).
- Add the action to `AdminAuditActionSchema` in `packages/api-types/src/admin.ts`.
- Add to `AdminAuditAction` union in `apps/server/src/services/admin-audit.ts`.
- Wrap the handler in the `withAudit` helper from `admin-accounts.ts` or `admin-force-actions.ts` so the audit row writes before the response.

### Add a new sub-processor (vendor)

This is a Tier 2 architectural decision per AGENTS.md. Surface for approval first; don't silently add. Once approved:

1. Update `AGENTS.md` sub-processor list.
2. Update `docs/legal/dpa.md` Annex 3 sub-processor table.
3. Update `docs/legal/privacy-policy.md` sub-processor disclosure.
4. Bump legal-doc version (forces re-acceptance).
5. Update `docs/deployment/env-vars.md` with the env vars the new vendor reads.
6. Add config block to `apps/server/src/lib/config.ts`.

### Run against real Stripe

The Stripe API is hand-rolled in `apps/server/src/lib/stripe-api.ts` — no `stripe` npm SDK dep. To test against real Stripe (test mode):

1. Get a test-mode `sk_test_…` key from the Stripe dashboard.
2. Set `STRIPE_SECRET_KEY=sk_test_…` in your local `.env`.
3. Set `DRIFTSTACK_TIER_PRICE_IDS` to a JSON map of `{ tier: { monthly, annual } }`. Test prices can be created via the Stripe dashboard.
4. Set `STRIPE_WEBHOOK_SECRET=whsec_…` (from the dashboard's test-mode webhook endpoint config) to enable inbound webhook verification.
5. Run `node scripts/stripe-bootstrap-prices.mjs --dry-run` to verify the canonical six products and twelve recurring prices without creating duplicates.
6. Use the Stripe CLI (`stripe listen --forward-to localhost:3000/v1/webhooks/stripe`) for end-to-end webhook testing.

NEVER set live-mode Stripe keys in your local `.env`. Live keys go through SSH-write to the Hetzner production VM only, post-KvK; never via chat or PR per the operational register.

### Generate the OpenAPI spec

It's auto-generated at runtime from the Zod schemas in `packages/api-types/`. Hit `/openapi.json` against a running dev server. To dump to a file:

```bash
npx tsx apps/server/src/lib/dump-openapi.ts openapi.json
```

The path is an argument, not a redirect — the script writes the file itself and prints where it
put it. `npm run sdk:python:dump-spec` is the same script wired to the path the Python SDK build
expects.

## When something's broken

- **`npm install` fails with workspace conflicts**: delete `node_modules/` + `package-lock.json`, re-run.
- **Postgres connection errors**: check `docker compose ps` — Postgres healthy? `docker compose down -v && docker compose up -d` resets the volume.
- **Drizzle migration fails partway through**: Drizzle's migration log lives in the `drizzle` schema. To force a clean re-apply: connect via `docker compose exec postgres psql -U driftstack` and `DROP SCHEMA drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`. Then `npm run db:migrate` again.
- **Tests fail with `port already in use`**: another dev server is running. `lsof -i :3000` (or relevant port) and kill it.
- **TypeScript types don't match what you wrote**: run `npm run build` first — incremental TS sometimes lags the source. If build also fails, check that `tsc --build` is happy with the project-references graph (the `tsconfig.json` files in each workspace).

## Where to go next

If you want to dive deeper before making your first change:

- Read `docs/architecture.md` end-to-end.
- Skim the most recent 5-10 V-log entries (`tail -300 docs/verification-log.md`) for current state of the world.
- Look at the V-079 (auth flow) or V-082 (billing flow) commits as examples of "what landing a feature end-to-end looks like."

If you have a specific change in mind, open the relevant test file first — it'll tell you the expected contract more reliably than the docs.
