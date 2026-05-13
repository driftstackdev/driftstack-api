// W540.A — drift guard for /AGENTS.md (workspace root).
// Repo-context + policy doc. The most policy-load-bearing file in
// the repo. Drift here either weakens the founder-anonymity posture
// (would risk re-introducing a personal-name reference to a
// customer-facing surface), drops the attribution-policy ban (would
// re-permit third-party tooling co-authored-by trailers on
// commits), or changes the locked-tech-stack list (which would
// imply a stack swap that should have been surfaced via decision log).
//
//   • Founder anonymity policy (Driftstack-the-entity framing).
//   • Git identity policy (Driftstack <dev@driftstack.dev>).
//   • Attribution policy (NO third-party tooling trailers, NO
//     "Generated with…" footers — every commit, every public file).
//   • Customer-facing copy policy (no tooling references).
//   • WebKit-fork boundary (separate repo; driver interface is the
//     contract).
//   • Repo scope (pure engineering + 2026-05-03 legal/billing/
//     customer-copy exception).
//   • Sub-processor list (10 entries; V-052).
//   • Crypto rail dropped from launch (Stripe sole rail; USDC/USDB
//     candidate for re-entry).
//   • Locked tech stack (Node 22 / TS 5.x / Fastify / Drizzle /
//     Postgres 17 / Redis 7 / Zod / Vitest / Pino).
//   • Decision authority 3-tier (autonomous / review / approval).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'AGENTS.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W540.A /AGENTS.md content parity', () => {
  const body = read(LIB);

  it("Founder-anonymity policy framing pinned: '## ⚠️ Founder anonymity policy' + 'Driftstack does not attribute work to a specific named person on customer-facing surfaces.' + 'DO NOT include personal founder name on `/about`, `/security`, `/docs`, marketing site, customer dashboard, admin panel, FAQ, or any public-facing surface.' + 'DO use \"Driftstack\" / \"the Driftstack team\" / \"we\" framing for company voice.' — pinned so the customer-facing-anonymity + Driftstack-entity-voice + internal-docs-may-reference-founder commitment survives (drift to mentioning a personal name on /about would break the anonymity posture this repo standardised on)", () => {
    expect(body).toMatch(/## ⚠️ Founder anonymity policy/);
    expect(body).toMatch(
      /Driftstack does not attribute work to a specific named person on customer-facing surfaces\./,
    );
    expect(body).toMatch(
      /\*\*DO NOT\*\* include personal founder name on `\/about`, `\/security`, `\/docs`, marketing site, customer dashboard, admin panel, FAQ, or any public-facing surface\./,
    );
    expect(body).toMatch(
      /\*\*DO\*\* use "Driftstack" \/ "the Driftstack team" \/ "we" framing for company voice\./,
    );
  });

  it("Git-identity policy framing pinned: '## ⚠️ Git identity policy' + 'All commits in this repo use the Driftstack-branded git identity, not a personal name + email.' + 'git config --local user.name \"Driftstack\"' + 'git config --local user.email \"dev@driftstack.dev\"' — pinned so the Driftstack-branded-identity + dev@driftstack.dev + per-clone-local-config commitment survives (drift to a personal name + email would attribute commits to an individual rather than the company)", () => {
    expect(body).toMatch(/## ⚠️ Git identity policy/);
    expect(body).toMatch(
      /All commits in this repo use the Driftstack-branded git identity, not a personal name \+ email\./,
    );
    expect(body).toMatch(/git config --local user\.name "Driftstack"/);
    expect(body).toMatch(/git config --local user\.email "dev@driftstack\.dev"/);
  });

  it("Attribution-policy framing pinned: '## ⚠️ Attribution policy (every commit, every public-visible file)' + 'Commits and repo content are attributed to the Driftstack identity, not to any external development tooling.' + 'DO NOT include any third-party tooling attribution trailer (any \"co-authored-by\"-style line naming external systems) on commits.' + 'DO NOT include any \"Generated with …\" footer or robot-emoji marker on commits.' + 'DO NOT reference development tooling by name in commit messages.' — pinned so the no-third-party-trailer + no-generated-with-footer + no-tooling-mention-in-commit-message commitment survives (drift to including a co-authored-by trailer would reveal tooling on public commit history)", () => {
    expect(body).toMatch(/## ⚠️ Attribution policy \(every commit, every public-visible file\)/);
    expect(body).toMatch(
      /Commits and repo content are attributed to the Driftstack identity, not to any external development tooling\./,
    );
    expect(body).toMatch(
      /\*\*DO NOT\*\* include any third-party tooling attribution trailer \(any "co-authored-by"-style line naming external systems\) on commits\./,
    );
    expect(body).toMatch(
      /\*\*DO NOT\*\* include any "Generated with …" footer or robot-emoji marker on commits\./,
    );
    expect(body).toMatch(
      /\*\*DO NOT\*\* reference development tooling by name in commit messages\./,
    );
  });

  it("Repo-scope + legal/billing/copy exception framing pinned: '## ⚠️ Repository scope' + 'The codebase is **pure engineering**.' + '**Exception (effective 2026-05-03):** legal/compliance baseline drafts are in-scope when explicitly directed.' + '**Exception extension (effective 2026-05-03):** the legal/compliance exception is extended to cover three additional categories' + 'Customer-facing copy' + 'Billing integration code' + 'Onboarding flow with copy' — pinned so the pure-engineering-by-default + 2026-05-03 exception + 3-additional-extension (copy + billing + onboarding) commitment survives (drift to dropping these would close out customer-facing work and billing integration)", () => {
    expect(body).toMatch(/## ⚠️ Repository scope/);
    expect(body).toMatch(/The codebase is \*\*pure engineering\*\*\./);
    expect(body).toMatch(
      /\*\*Exception \(effective 2026-05-03\):\*\* legal\/compliance baseline drafts are in-scope when explicitly directed\./,
    );
    expect(body).toMatch(
      /\*\*Exception extension \(effective 2026-05-03\):\*\* the legal\/compliance exception is extended to cover three additional categories/,
    );
    expect(body).toMatch(/\*\*Customer-facing copy\*\*/);
    expect(body).toMatch(/\*\*Billing integration code\*\*/);
    expect(body).toMatch(/\*\*Onboarding flow with copy\*\*/);
  });

  it("V-052 sub-processor list + Stripe-sole-rail framing pinned: 'Sub-processor list (revised 2026-05-03 — V-052): Hetzner, Neon, Upstash, Cloudflare (R2 + Pages + DNS), Postmark, Sentry, Stripe, Anthropic (BYO bundled LLM only, opt-in), Moneybird, MacStadium.' + 'Crypto rail dropped from launch (2026-05-03): Coinbase Commerce closed for non-US/Singapore merchants 2026-03-31. Stripe is the sole payment rail at launch (fiat-only).' + 'Stripe\\'s native USDC/USDB support (Dec 2025) is the candidate for crypto re-entry' — pinned so the V-052 10-sub-processor list + Coinbase-dropped + Stripe-sole + USDC-USDB-candidate-for-re-entry commitment survives (drift to adding a sub-processor outside the list = silent scope expansion)", () => {
    expect(body).toMatch(
      /Sub-processor list \(revised 2026-05-03 — V-052\): Hetzner, Neon, Upstash, Cloudflare \(R2 \+ Pages \+ DNS\), Postmark, Sentry, Stripe, Anthropic \(BYO bundled LLM only, opt-in\), Moneybird, MacStadium\./,
    );
    expect(body).toMatch(
      /\*\*Crypto rail dropped from launch \(2026-05-03\):\*\* Coinbase Commerce closed for non-US\/Singapore merchants 2026-03-31\. Stripe is the sole payment rail at launch \(fiat-only\)\./,
    );
    expect(body).toMatch(
      /Stripe's native USDC\/USDB support \(Dec 2025\) is the candidate for crypto re-entry/,
    );
  });

  it("Locked-tech-stack framing pinned: '## Locked tech stack' + 'Node.js 22 LTS · TypeScript 5.x strict' + 'Fastify · Drizzle (Postgres 17) · ioredis (Redis 7)' + 'Zod (single source of truth, OpenAPI 3.1 generated from it)' + 'Custom API keys (long-lived, scoped, revocable; scrypt-hashed at rest)' + 'Vitest unit + Supertest integration + Playwright e2e' + 'Pino structured JSON logging' + 'Docker Compose dev infra · GitHub Actions CI' — pinned so the 8-anchor locked-stack commitment survives (drift to a different ORM or HTTP framework would invalidate every architecture-doc reference)", () => {
    expect(body).toMatch(/## Locked tech stack/);
    expect(body).toMatch(/Node\.js 22 LTS · TypeScript 5\.x strict/);
    expect(body).toMatch(/Fastify · Drizzle \(Postgres 17\) · ioredis \(Redis 7\)/);
    expect(body).toMatch(/Zod \(single source of truth, OpenAPI 3\.1 generated from it\)/);
    expect(body).toMatch(
      /Custom API keys \(long-lived, scoped, revocable; scrypt-hashed at rest\)/,
    );
    expect(body).toMatch(/Vitest unit \+ Supertest integration \+ Playwright e2e/);
    expect(body).toMatch(/Pino structured JSON logging/);
    expect(body).toMatch(/Docker Compose dev infra · GitHub Actions CI/);
  });

  it("Decision-authority 3-tier framing pinned: '## Decision authority' + '**Autonomous (routine implementation):**' + '**Surface for review (architectural / contractual):**' + '**Surface for explicit approval (commercial / brand):**' — pinned so the 3-tier autonomy ladder (routine-implementation / architectural-or-contractual-review / commercial-or-brand-approval) commitment survives (drift to collapsing tiers would risk silent scope expansion into brand or commercial commitments)", () => {
    expect(body).toMatch(/## Decision authority/);
    expect(body).toMatch(/\*\*Autonomous \(routine implementation\):\*\*/);
    expect(body).toMatch(/\*\*Surface for review \(architectural \/ contractual\):\*\*/);
    expect(body).toMatch(/\*\*Surface for explicit approval \(commercial \/ brand\):\*\*/);
  });

  it("WebKit-driver-boundary framing pinned: '## WebKit driver boundary' + 'The WebKit fork lives in a separate repository on a separate stack.' + 'the mock driver in `mock.ts` is the standing implementation, and the real WebKit driver swaps in once the fork\\'s Phase 2 closes.' + 'Driver-interface changes are coordinated explicitly. Don\\'t read fork internals to make implementation decisions in this repo — the interface is the only contract.' — pinned so the separate-repo + mock-as-standing-impl + driver-interface-is-only-contract commitment survives (drift to reading fork internals would couple this repo to fork details and break the boundary that makes the WebKit Phase-2 swap safe)", () => {
    expect(body).toMatch(/## WebKit driver boundary/);
    expect(body).toMatch(/The WebKit fork lives in a separate repository on a separate stack\./);
    expect(body).toMatch(
      /the mock driver in `mock\.ts` is the standing implementation, and the real WebKit driver swaps in once the fork's Phase 2 closes\./,
    );
    expect(body).toMatch(
      /Driver-interface changes are coordinated explicitly\. Don't read fork internals to make implementation decisions in this repo — the interface is the only contract\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
