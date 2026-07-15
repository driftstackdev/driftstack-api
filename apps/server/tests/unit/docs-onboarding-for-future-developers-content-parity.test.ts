// W547.A — drift guard for /docs/onboarding-for-future-developers.md.
// Single-source onboarding doc for new contributors + future-self.
// Drift here either misrepresents the daily dev loop (would block
// onboarding), changes the dev-port allocation (would diverge from
// the actual local-dev workflow), or drops the live-mode-Stripe
// 'never via chat or PR' rule (would risk credential exposure).
//
//   • Last-refresh 2026-05-03 (V-102).
//   • Prereq table: Node 22 LTS + npm 10+ + Docker 4.x+ + Rust
//     toolchain (optional) + Python 3.11+ (optional).
//   • 6-command first-run setup (git clone + nvm use + npm install +
//     docker compose up + db:migrate + db:seed).
//   • Daily dev loop: server :3000 + marketing-site :4321 +
//     customer-dashboard :4322.
//   • Verification chain: typecheck + lint + format:check + test +
//     build.
//   • E2E: workers:1 + DROP+re-create schema per suite.
//   • Common tasks: add column / add endpoint / add admin endpoint
//     / add sub-processor / run-against-real-Stripe.
//   • NEVER set live-mode Stripe keys in local .env.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/onboarding-for-future-developers.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W547.A /docs/onboarding-for-future-developers.md content parity', () => {
  const body = read(LIB);

  it('uses the current six-product/twelve-price Stripe test-mode workflow', () => {
    expect(body).toMatch(/Run `node scripts\/stripe-bootstrap-prices\.mjs --dry-run`/);
    expect(body).toMatch(/canonical six products and twelve recurring prices/);
    expect(body).not.toMatch(/Set `STRIPE_TRIAL_PACK_PRICE_ID`/);
  });

  it("Header + audience + V-102 refresh + monorepo-shape framing pinned: '# Onboarding for future developers' + 'Audience' + 'future contributors (including future-you in 6 months when you've forgotten the local-dev steps).' + 'Last refresh: 2026-05-03 (V-102).' + 'one-stop \"how do I get this running locally + what's the dev loop\" reference' + 'single TypeScript monorepo with multiple workspaces (Astro marketing site, Astro customer dashboard, Tauri GUI client, Fastify control plane, several SDKs)' + 'npm install && npm run dev does most of what you need' — pinned so the V-102-last-refresh + future-self-in-6-months + npm-install-then-dev + monorepo-inventory commitment survives", () => {
    expect(body).toMatch(/^# Onboarding for future developers$/m);
    expect(body).toMatch(/\*\*Audience:\*\* future contributors/);
    expect(body).toMatch(
      /\(including future-you in 6 months when you've forgotten the local-dev steps\)/,
    );
    expect(body).toMatch(/\*\*Last refresh:\*\* 2026-05-03 \(V-102\)\./);
    expect(body).toMatch(
      /one-stop "how do I get this running locally \+ what's the dev loop" reference/,
    );
    expect(body).toMatch(/single TypeScript monorepo with multiple workspaces/);
    expect(body).toMatch(
      /\(Astro marketing site, Astro customer dashboard, Tauri GUI client, Fastify control plane, several SDKs\)/,
    );
    expect(body).toMatch(/`npm install && npm run dev` does most of what you need/);
  });

  it("Prerequisites 5-tool table framing pinned: '## Prerequisites' + 'Node.js | 22 LTS | `.nvmrc` pins this. Use `nvm use` or fnm.' + 'npm | 10+ | We use npm workspaces; do not switch to pnpm/yarn.' + 'Docker | 4.x+ | For Postgres 17 + Redis 7 dev infra' + 'Rust toolchain | optional | Only if touching the GUI client (Tauri).' + 'Python | 3.11+ optional | Only if touching the Python SDK' — pinned so the 5-tool table + Node-22-LTS + npm-workspaces-NOT-pnpm/yarn + Docker-4.x + optional-Rust + optional-Python-3.11+ commitment survives (drift to switching to pnpm would invalidate this table)", () => {
    expect(body).toMatch(/## Prerequisites/);
    expect(body).toMatch(/Node\.js\s+\|\s+22 LTS\s+\|\s+`\.nvmrc` pins this/);
    expect(body).toMatch(/`nvm use` or fnm\./);
    expect(body).toMatch(/npm\s+\|\s+10\+\s+\|\s+Bundled with Node\. We use npm workspaces/);
    expect(body).toMatch(/do not switch to pnpm\/yarn\./);
    expect(body).toMatch(/Docker\s+\|\s+4\.x\+\s+\|\s+For Postgres 17 \+ Redis 7 dev infra/);
    expect(body).toMatch(/Rust toolchain\s+\|\s+optional\s+\|\s+Only if touching the GUI client/);
    expect(body).toMatch(/Python\s+\|\s+3\.11\+ optional\s+\|\s+Only if touching the Python SDK/);
  });

  it("First-run 6-command + db:seed-prints-API-key framing pinned: '## First-run setup' + 'git clone https://github.com/driftstackdev/driftstack-api.git' + 'cd driftstack-api' + 'nvm use                    # or fnm use' + 'npm install                # installs across all workspaces' + 'docker compose up -d       # boots Postgres + Redis' + 'npm run db:migrate         # applies Drizzle migrations' + 'npm run db:seed            # seeds a dev account + API key' + 'Expected output of seed: a printed plaintext API key starting `ds_test_…`. Save it; the dev server uses it for `Authorization: Bearer <key>` headers in your local browser tabs.' — pinned so the 6-command first-run sequence + ds_test_ plaintext-API-key + Authorization-Bearer-header commitment survives", () => {
    expect(body).toMatch(/## First-run setup/);
    expect(body).toMatch(/git clone https:\/\/github\.com\/driftstackdev\/driftstack-api\.git/);
    expect(body).toMatch(/cd driftstack-api/);
    expect(body).toMatch(/nvm use\s+# or fnm use/);
    expect(body).toMatch(/npm install\s+# installs across all workspaces/);
    expect(body).toMatch(/docker compose up -d\s+# boots Postgres \+ Redis/);
    expect(body).toMatch(/npm run db:migrate\s+# applies Drizzle migrations/);
    expect(body).toMatch(/npm run db:seed\s+# seeds a dev account \+ API key/);
    expect(body).toMatch(
      /Expected output of seed: a printed plaintext API key starting `ds_test_…`\./,
    );
    expect(body).toMatch(
      /Save it; the dev server uses it for `Authorization: Bearer <key>` headers/,
    );
  });

  it('Daily dev loop pins marketing 4321 and activation-compatible customer dashboard 5173', () => {
    expect(body).toMatch(/## Daily dev loop/);
    expect(body).toMatch(/npm run dev$/m);
    expect(body).toMatch(/# Run the marketing site \(separate terminal\)\./);
    expect(body).toMatch(/npm run dev --workspace apps\/marketing-site/);
    expect(body).toMatch(/# → http:\/\/localhost:4321/);
    expect(body).toMatch(/npm run dev --workspace apps\/customer-dashboard/);
    expect(body).toMatch(/# → http:\/\/localhost:5173/);
    expect(body).toMatch(/npm run dev --workspace apps\/gui-client/);
    expect(body).toMatch(/The control plane defaults to `http:\/\/localhost:3000`\./);
    expect(body).toMatch(/OpenAPI spec at `\/openapi\.json`, Swagger UI at `\/docs`\./);
  });

  it("Verification chain + e2e hermetic framing pinned: '## Verification chain' + 'npm run typecheck     # strict TS + Astro check across all 6 workspaces' + 'npm run lint          # eslint with type-aware rules' + 'npm run format:check  # prettier' + 'npm test              # vitest unit + integration (~6-8s for 478 tests)' + 'npm run build         # tsc --build all workspaces' + 'For e2e tests against real Postgres + Redis (Playwright suite)' + 'npm run test:e2e --workspace apps/server' + 'E2E tests are slower (~30-60s) and run with `workers: 1` because the test database is shared. They DROP and re-create the public schema at test-suite start, so they're hermetic.' — pinned so the 5-command verification chain + e2e-workers:1 + DROP-and-re-create-schema hermetic commitment survives", () => {
    expect(body).toMatch(/## Verification chain/);
    expect(body).toMatch(/npm run typecheck\s+# strict TS \+ Astro check across all 6 workspaces/);
    expect(body).toMatch(/npm run lint\s+# eslint with type-aware rules/);
    expect(body).toMatch(/npm run format:check\s+# prettier/);
    expect(body).toMatch(/npm test\s+# vitest unit \+ integration \(~6-8s for 478 tests\)/);
    expect(body).toMatch(/npm run build\s+# tsc --build all workspaces/);
    expect(body).toMatch(/For e2e tests against real Postgres \+ Redis \(Playwright suite\):/);
    expect(body).toMatch(/npm run test:e2e --workspace apps\/server/);
    expect(body).toMatch(/E2E tests are slower \(~30-60s\) and run with `workers: 1`/);
    expect(body).toMatch(/because the test database is shared\. They DROP and re-create the/);
    expect(body).toMatch(/public schema at test-suite start, so they're hermetic\./);
  });

  it("3-decision-doc + AGENTS.md anchor framing pinned: '## How the codebase makes decisions' + 'Three docs you'll consult:' + '`docs/decisions.md` — D-NNN entries.' + '`docs/verification-log.md` — V-NNN entries. Append-only empirical log of every substantive change.' + '`docs/adr/` — long-form ADRs for architectural deviations from the planned approach.' + 'ADR-001 hosting, ADR-002 Stripe-only, ADR-003 trial pack, ADR-004 two-ladder pricing, ADR-005 observability draft, ADR-006 audit retention draft' + 'AGENTS.md at the repo root captures the full operational discipline: test standards, marketing-copy review cadence, decision-authority levels (Routine / Architectural / Contractual), commit pattern (push-to-main with V-NNN tag), what's in scope vs out of scope.' — pinned so the 3-decision-doc (decisions.md + verification-log.md + adr/) + 6-ADR-anchor (ADR-001 through ADR-006) + AGENTS.md-as-operational-discipline + 3-tier-decision-authority commitment survives", () => {
    expect(body).toMatch(/## How the codebase makes decisions/);
    expect(body).toMatch(/Three docs you'll consult:/);
    expect(body).toMatch(/- \*\*`docs\/decisions\.md`\*\* — D-NNN entries\./);
    expect(body).toMatch(
      /- \*\*`docs\/verification-log\.md`\*\* — V-NNN entries\. Append-only empirical log of every substantive change\./,
    );
    expect(body).toMatch(
      /- \*\*`docs\/adr\/`\*\* — long-form ADRs for architectural deviations from the planned approach\./,
    );
    expect(body).toMatch(/ADR-001 hosting, ADR-002 Stripe-only, ADR-003 trial pack/);
    expect(body).toMatch(
      /ADR-004 two-ladder pricing, ADR-005 observability draft, ADR-006 audit retention draft/,
    );
    expect(body).toMatch(/AGENTS\.md at the repo root captures the full operational discipline:/);
    expect(body).toMatch(
      /test standards, marketing-copy review cadence, decision-authority levels/,
    );
    expect(body).toMatch(
      /\(Routine \/ Architectural \/ Contractual\), commit pattern \(push-to-main with V-NNN tag\)/,
    );
  });

  it("Real-Stripe + sk_live_ never-in-local-env framing pinned: '### Run against real Stripe' + 'The Stripe API is hand-rolled in `apps/server/src/lib/stripe-api.ts` — no `stripe` npm SDK dep.' + 'Get a test-mode `sk_test_…` key from the Stripe dashboard.' + 'Set `STRIPE_SECRET_KEY=sk_test_…` in your local `.env`.' + 'Use the Stripe CLI (`stripe listen --forward-to localhost:3000/v1/webhooks/stripe`)' + 'NEVER set live-mode Stripe keys in your local `.env`. Live keys go through SSH-write to the Hetzner production VM only, post-KvK; never via chat or PR per the operational register.' — pinned so the Stripe-hand-rolled-no-npm-SDK + sk_test_-OK-in-local-.env + NEVER-sk_live_-in-local-.env + Stripe-CLI-forward-to-/v1/webhooks/stripe + SSH-write-only commitment survives", () => {
    expect(body).toMatch(/### Run against real Stripe/);
    expect(body).toMatch(
      /The Stripe API is hand-rolled in `apps\/server\/src\/lib\/stripe-api\.ts` — no `stripe` npm SDK dep\./,
    );
    expect(body).toMatch(/1\. Get a test-mode `sk_test_…` key from the Stripe dashboard\./);
    expect(body).toMatch(/2\. Set `STRIPE_SECRET_KEY=sk_test_…` in your local `\.env`\./);
    expect(body).toMatch(
      /6\. Use the Stripe CLI \(`stripe listen --forward-to localhost:3000\/v1\/webhooks\/stripe`\)/,
    );
    expect(body).toMatch(/NEVER set live-mode Stripe keys in your local `\.env`\./);
    expect(body).toMatch(
      /Live keys go through SSH-write to the Hetzner production VM only, post-KvK; never via chat or PR per the operational register\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
