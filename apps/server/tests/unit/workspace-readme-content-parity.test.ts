// W540.B — drift guard for /README.md (workspace root).
// Public-facing repo intro. The first thing a contributor or
// curious npm-package-consumer sees. Drift here either misrepresents
// the stack (would mislead contributors about what they're cloning),
// drops the WebKit-fork-separate-repo framing (would conflate the
// control plane with the browser engine), or breaks the documented
// setup steps (would block onboarding).
//
//   • Top-line: Driftstack API — Customer-facing REST API + control
//     plane for iPhone Safari automation.
//   • Status: Active development. Mock driver in this repo;
//     real driver in WebKit fork repo.
//   • Stack: Node 22 LTS + Fastify + Drizzle + Postgres 17 + Redis 7
//     + Zod-OpenAPI-3.1 + Vitest + Playwright + Pino + Docker Compose
//     + GitHub Actions.
//   • Repo layout: 6 apps (server + 5 Astro/Tauri) + 9 packages.
//   • Setup: Node 22 LTS + Docker Desktop + npm 10+ +
//     docker-compose 5432/6379 driftstack/driftstack/driftstack.
//   • Auth surfaces: API keys (long-lived, scoped, revocable,
//     scrypt-hashed, sha256-keyed Redis cache 30s TTL) + Web sessions
//     (opaque sha256, 30d TTL, revocable).
//   • License: MIT.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'README.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W540.B /README.md content parity', () => {
  const body = read(LIB);

  it("Top-line + Status framing pinned: '# Driftstack API' + 'Customer-facing REST API and control plane for Driftstack — an iPhone Safari automation platform.' + '> **Status:** Active development.' + 'The WebKit driver interface is the contract between this control plane and the browser engine; a mock driver ships in this repo and the real driver ships in the WebKit fork repo.' — pinned so the iPhone-Safari-automation-platform + active-development + WebKit-fork-separate-repo + driver-interface-contract commitment survives (drift to a different platform framing would misrepresent what we're shipping)", () => {
    expect(body).toMatch(/^# Driftstack API$/m);
    expect(body).toMatch(
      /Customer-facing REST API and control plane for Driftstack — an iPhone Safari automation platform\./,
    );
    expect(body).toMatch(/> \*\*Status:\*\* Active development\./);
    expect(body).toMatch(
      /The WebKit driver interface is the contract between this control plane and\s*\n?>\s*the browser engine; a mock driver ships in this repo and the real driver\s*\n?>\s*ships in the WebKit fork repo\./,
    );
  });

  it("Stack framing pinned: 'Node.js 22 LTS, TypeScript 5.x strict mode' + '[Fastify](https://fastify.dev/) HTTP server' + '[Drizzle ORM](https://orm.drizzle.team/) on Postgres 17' + 'Redis 7 for ephemeral state, rate limiting, session caching' + '[Zod](https://zod.dev/) as single source of truth (OpenAPI 3.1 generated from Zod)' + 'Vitest (unit + integration) and Playwright (e2e)' + 'Pino structured JSON logging' + 'Docker Compose for dev infra' + 'GitHub Actions CI' — pinned so the 9-stack-anchor public framing commitment survives", () => {
    expect(body).toMatch(/Node\.js 22 LTS, TypeScript 5\.x strict mode/);
    expect(body).toMatch(/\[Fastify\]\(https:\/\/fastify\.dev\/\) HTTP server/);
    expect(body).toMatch(/\[Drizzle ORM\]\(https:\/\/orm\.drizzle\.team\/\) on Postgres 17/);
    expect(body).toMatch(/Redis 7 for ephemeral state, rate limiting, session caching/);
    expect(body).toMatch(
      /\[Zod\]\(https:\/\/zod\.dev\/\) as single source of truth \(OpenAPI 3\.1 generated from Zod\)/,
    );
    expect(body).toMatch(/Vitest \(unit \+ integration\) and Playwright \(e2e\)/);
    expect(body).toMatch(/Pino structured JSON logging/);
    expect(body).toMatch(/Docker Compose for dev infra/);
    expect(body).toMatch(/GitHub Actions CI/);
  });

  it("6-app + 9-package monorepo layout framing pinned: 'apps/server' (Fastify API + control plane) + 'marketing-site' (driftstack.dev) + 'customer-dashboard' (app.driftstack.dev) + 'admin-panel' (internal) + 'docs' (docs.driftstack.dev) + 'status-site' (status.driftstack.dev) + 'gui-client' (Tauri desktop client macOS/Windows/Linux) + 9 packages (api-types + sdk-typescript + sdk-python + sdk-go + behavioural-simulation + recipe-library + recapture-automation + webrtc-streaming + webhook-delivery) — pinned so the full 6-app + 9-package public inventory commitment survives (drift to dropping a SDK from the list would mislead consumers about which language SDKs ship)", () => {
    expect(body).toMatch(/server\/\s*#\s*Fastify API \+ control plane/);
    expect(body).toMatch(/marketing-site\/\s*#\s*Astro static-build \(driftstack\.dev\)/);
    expect(body).toMatch(
      /customer-dashboard\/\s*#\s*Astro customer portal \(app\.driftstack\.dev\)/,
    );
    expect(body).toMatch(/admin-panel\/\s*#\s*Astro admin UI \(internal\)/);
    expect(body).toMatch(/docs\/\s*#\s*Astro docs site \(docs\.driftstack\.dev\)/);
    expect(body).toMatch(/status-site\/\s*#\s*Status page \(status\.driftstack\.dev\)/);
    expect(body).toMatch(/gui-client\/\s*#\s*Tauri desktop client \(macOS \/ Windows \/ Linux\)/);
    expect(body).toMatch(/api-types\//);
    expect(body).toMatch(/sdk-typescript\//);
    expect(body).toMatch(/sdk-python\//);
    expect(body).toMatch(/sdk-go\//);
    expect(body).toMatch(/behavioural-simulation\//);
    expect(body).toMatch(/recipe-library\//);
    expect(body).toMatch(/recapture-automation\//);
    expect(body).toMatch(/webrtc-streaming\//);
    expect(body).toMatch(/webhook-delivery\//);
  });

  it("Setup-prereqs + compose-credentials framing pinned: 'Node.js 22 LTS (`.nvmrc` pins this — `nvm use` if you have nvm)' + 'Docker Desktop (for Postgres + Redis)' + 'npm 10+' + 'git clone https://github.com/driftstackdev/driftstack-api.git' + 'docker compose up -d' + 'This brings up Postgres 17 on `localhost:5432` and Redis 7 on `localhost:6379`. Credentials: `driftstack` / `driftstack` / db `driftstack`.' — pinned so the Node-22-LTS-prereq + GitHub-org-driftstackdev + docker-compose-up + driftstack/driftstack/driftstack 3-credential commitment survives (drift to a different GitHub org or different credentials would block new-contributor onboarding)", () => {
    expect(body).toMatch(/Node\.js 22 LTS \(`\.nvmrc` pins this — `nvm use` if you have nvm\)/);
    expect(body).toMatch(/Docker Desktop \(for Postgres \+ Redis\)/);
    expect(body).toMatch(/npm 10\+/);
    expect(body).toMatch(/git clone https:\/\/github\.com\/driftstackdev\/driftstack-api\.git/);
    expect(body).toMatch(/docker compose up -d/);
    expect(body).toMatch(
      /This brings up Postgres 17 on `localhost:5432` and Redis 7 on `localhost:6379`\. Credentials: `driftstack` \/ `driftstack` \/ db `driftstack`\./,
    );
  });

  it('Configuration env groups and independent vendor failure contracts stay production-accurate', () => {
    expect(body).toMatch(
      /The Zod schema in `apps\/server\/src\/lib\/config\.ts` validates at startup\. The canonical reference is `docs\/deployment\/env-vars\.md`/,
    );
    expect(body).toMatch(/\*\*Process\*\*: `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `DRIVER`\./);
    expect(body).toMatch(
      /\*\*Postgres \/ Redis\*\*: `DATABASE_URL`, `REDIS_URL` \(dev defaults to docker-compose\)\./,
    );
    expect(body).toMatch(
      /\*\*Cloudflare R2\*\* \(optional\): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_RECORDINGS`\./,
    );
    expect(body).toMatch(
      /\*\*Postmark\*\* \(optional\): `POSTMARK_API_TOKEN`, `POSTMARK_FROM`, `POSTMARK_REPLY_TO`\./,
    );
    expect(body).toMatch(
      /\*\*Sentry\*\* \(optional\): `SENTRY_DSN` \(EU region required\), `SENTRY_ENVIRONMENT`\./,
    );
    expect(body).toMatch(
      /\*\*Stripe\*\* \(optional\): `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `DRIFTSTACK_TIER_PRICE_IDS` \(six paid tiers, monthly \+ annual\)\./,
    );
    expect(body).not.toMatch(/STRIPE_TRIAL_PACK_PRICE_ID/);
    expect(body).toMatch(
      /\*\*Auth-flow links\*\*: `AUTH_VERIFY_EMAIL_URL`, `AUTH_MAGIC_LINK_URL`, `AUTH_PASSWORD_RESET_URL`\./,
    );
    expect(body).toMatch(
      /Vendor integrations fail independently so the rest of the API stays up\./,
    );
    expect(body).toMatch(
      /`\/v1\/billing\/\*` returns a typed `503 FeatureUnavailable` until `STRIPE_SECRET_KEY` and `DRIFTSTACK_TIER_PRICE_IDS` are configured/,
    );
    expect(body).toMatch(
      /`\/v1\/webhooks\/stripe` is gated independently by `STRIPE_WEBHOOK_SECRET`/,
    );
  });

  it("Authentication-2-surface + License framing pinned: 'API keys (long-lived, scoped, revocable) — for SDK consumers. Pass as `Authorization: Bearer <key>`. Issuance via `POST /v1/api-keys`. scrypt-hashed at rest; sha256-keyed Redis cache with 30s TTL.' + 'Web sessions (opaque sha256 tokens, 30d TTL, revocable) — for browser dashboard / admin panel. Issued by `/v1/auth/{login,verify-email,magic-link/consume,password-reset/confirm}`; rotated by `/v1/auth/refresh`.' + '## License' + 'MIT' — pinned so the API-keys-scrypt-hashed-sha256-keyed-30s-Redis-TTL + Web-sessions-opaque-sha256-30d-TTL + MIT-license commitment survives", () => {
    expect(body).toMatch(
      /\*\*API keys\*\* \(long-lived, scoped, revocable\) — for SDK consumers\. Pass as `Authorization: Bearer <key>`\. Issuance via `POST \/v1\/api-keys`\. scrypt-hashed at rest; sha256-keyed Redis cache with 30s TTL\./,
    );
    expect(body).toMatch(
      /\*\*Web sessions\*\* \(opaque sha256 tokens, 30d TTL, revocable\) — for browser dashboard \/ admin panel\. Issued by `\/v1\/auth\/\{login,verify-email,magic-link\/consume,password-reset\/confirm\}`; rotated by `\/v1\/auth\/refresh`\./,
    );
    expect(body).toMatch(/## License/);
    expect(body).toMatch(/^MIT$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
