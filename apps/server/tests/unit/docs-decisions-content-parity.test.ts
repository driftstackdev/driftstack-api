// W549.A — drift guard for /docs/decisions.md.
// Chronological decision log. Drift here either weakens the
// 3-tier decision-authority model (Routine + Architectural +
// Contractual — drives whether the agent surfaces for review),
// drops a load-bearing D-NNN that the codebase still depends on,
// or changes the V-log linkage pattern (would orphan ADR-style
// decisions from the empirical V-NNN audit trail).
//
//   • Format: D-NNN — title (one line). V-log cross-reference.
//   • Tier 1 Routine / Tier 2 Architectural / Tier 3 Contractual.
//   • D-001 locked-stack baseline (Node 22 + TS strict + Fastify
//     + Drizzle + Postgres 17 + Redis 7 + Zod + Vitest + Pino).
//   • D-007 push-to-main, no PR (mirrors WebKit fork D-12).
//   • D-020 Redis-30s-TTL auth cache + cache-version-bump on
//     mutation security model.
//   • D-025 admin tooling: scope model + audit logging + cache
//     invalidation + rate-limit override.
//   • D-026 Hetzner Cloud (architectural deviation from PaaS).
//   • D-027 Stripe-only (architectural deviation from Mollie).
//   • D-028 web sessions opaque sha256, not JWT.
//   • D-030 Stripe webhook idempotency via processed_stripe_events.
//   • D-035 admin scope at Fastify preHandler, not service layer.
//   • D-2026-05-06-* GUI keychain + Sentry opt-in + Tauri Updater.
//   • D-2026-05-10-01 OAuth PKCE S256 + opaque tokens.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/decisions.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W549.A /docs/decisions.md content parity', () => {
  const body = read(LIB);

  it("Header + 3-tier decision-authority model pinned: '# Driftstack API — Decision Log' + 'Chronological record of decisions affecting the `driftstack-api` repo.' + 'Format: `D-NNN — title (one line)`' + 'Routine — implementation detail inside the locked stack; landed and recorded' + 'Architectural — vendor / dependency / structural; surface for review before commit' + 'Contractual — affects API contract, CAPABILITIES.md, or WebKit-fork integration; explicit approval required' — pinned so the D-NNN-format + V-log-cross-reference + 3-tier-Routine-Architectural-Contractual + agent-surface-before-commit-Architectural + explicit-approval-Contractual commitment survives", () => {
    expect(body).toMatch(/^# Driftstack API — Decision Log$/m);
    expect(body).toMatch(/Chronological record of decisions affecting the `driftstack-api` repo\./);
    expect(body).toMatch(/Format: `D-NNN — title \(one line\)`\./);
    expect(body).toMatch(
      /- \*\*Routine\*\* — implementation detail inside the locked stack; landed and recorded/,
    );
    expect(body).toMatch(
      /- \*\*Architectural\*\* — vendor \/ dependency \/ structural; surface for review before commit/,
    );
    expect(body).toMatch(
      /- \*\*Contractual\*\* — affects API contract, CAPABILITIES\.md, or WebKit-fork integration; explicit approval required/,
    );
  });

  it("D-001 locked-stack baseline framing pinned: '## D-001 — Locked stack baseline' + 'Node 22 LTS, TypeScript 5.x strict, Fastify, Drizzle on Postgres 17, ioredis on Redis 7, Zod (single source of truth, OpenAPI 3.1 generated), Vitest + Supertest + Playwright, Pino, Docker Compose, GitHub Actions.' + 'Tier: 3 (set in spec; agent does not change without surfacing).' — pinned so the locked-stack inventory + Tier-3-spec-locked-no-agent-change commitment survives", () => {
    expect(body).toMatch(/## D-001 — Locked stack baseline/);
    expect(body).toMatch(
      /Node 22 LTS, TypeScript 5\.x strict, Fastify, Drizzle on Postgres 17, ioredis on Redis 7,/,
    );
    expect(body).toMatch(
      /Zod \(single source of truth, OpenAPI 3\.1 generated\), Vitest \+ Supertest \+ Playwright,/,
    );
    expect(body).toMatch(/Pino, Docker Compose, GitHub Actions\./);
    expect(body).toMatch(
      /\*\*Tier:\*\* 3 \(set in spec; agent does not change without surfacing\)\./,
    );
  });

  it("D-007 push-to-main framing pinned: '## D-007 — Push-to-main, no PR workflow (mirrors WebKit agent)' + 'every commit is pushed directly to main. No PRs, no branches, no review workflow.' + 'mirrors the WebKit fork repo's `D-12` pattern' — pinned so the no-PR-workflow + per-feature-PR-zero-value + V-log+decisions-as-discipline commitment survives", () => {
    expect(body).toMatch(/## D-007 — Push-to-main, no PR workflow \(mirrors WebKit agent\)/);
    expect(body).toMatch(
      /every commit is pushed directly to main\. No PRs, no branches, no review workflow\./,
    );
    expect(body).toMatch(/mirrors the WebKit fork repo's `D-12` pattern\./);
  });

  it('D-020 + D-025 + D-026 + D-027 + D-028 architectural/contractual framing pinned: D-020 Redis-30s-TTL + D-025 admin tooling + D-026 Hetzner Cloud (Architectural deviation from PaaS) + D-027 Stripe-only (Architectural deviation from Mollie-primary plan) + D-028 web sessions opaque sha256 — pinned so the architectural-deviation-from-spec + auth-cache-security-model + opaque-not-JWT commitment survives', () => {
    expect(body).toMatch(/## D-020 — Auth cache \(Redis-backed, 30 s TTL\) — security model/);
    expect(body).toMatch(
      /## D-025 — Admin tooling: scope model, audit logging, cache invalidation, rate-limit override/,
    );
    expect(body).toMatch(
      /## D-026 — Control-plane hosting on Hetzner Cloud \(Architectural deviation from PaaS plan\)/,
    );
    expect(body).toMatch(
      /## D-027 — Stripe-only payment processing at launch \(Architectural deviation from Mollie-primary plan\)/,
    );
    expect(body).toMatch(/## D-028 — Web sessions are opaque sha256-hashed tokens \(not JWT\)/);
  });

  it("D-029 + D-030 + D-031 + D-035 Stripe-webhook-idempotency + admin-scope-preHandler framing pinned: '## D-029 — Hand-rolled Stripe HTTP client (no `stripe` npm SDK dep)' + '## D-030 — Inbound Stripe webhook idempotency via `processed_stripe_events` PK' + '## D-031 — `session.failed` first-failure-only emission semantic' + '## D-035 — Admin scope enforcement at Fastify preHandler, not service layer' — pinned so the no-stripe-npm-dep + processed_stripe_events-idempotency + first-failure-dedup + preHandler-not-service-layer commitment survives", () => {
    expect(body).toMatch(/## D-029 — Hand-rolled Stripe HTTP client \(no `stripe` npm SDK dep\)/);
    expect(body).toMatch(
      /## D-030 — Inbound Stripe webhook idempotency via `processed_stripe_events` PK/,
    );
    expect(body).toMatch(/## D-031 — `session\.failed` first-failure-only emission semantic/);
    expect(body).toMatch(
      /## D-035 — Admin scope enforcement at Fastify preHandler, not service layer/,
    );
  });

  it("D-2026-05-06-* GUI distribution + telemetry + storage + D-2026-05-10-01 OAuth PKCE framing pinned: '## D-2026-05-06-01 — GUI API key at-rest storage: keyring-rs (OS keychain per-platform)' + '## D-2026-05-06-02 — GUI telemetry: Sentry crash-only, opt-in, cloud-default-on / self-hosted-default-off' + '## D-2026-05-06-03 — GUI distribution: Tauri Updater + GitHub Releases (cross-platform)' + '## D-2026-05-10-01 — OAuth 2.0 third-party flow uses PKCE S256, opaque tokens (no JWT)' — pinned so the keyring-rs-per-platform + Sentry-crash-only-opt-in-self-hosted-default-off + Tauri-Updater-GitHub-Releases + OAuth-PKCE-S256-opaque-no-JWT commitment survives", () => {
    expect(body).toMatch(
      /## D-2026-05-06-01 — GUI API key at-rest storage: keyring-rs \(OS keychain per-platform\)/,
    );
    expect(body).toMatch(
      /## D-2026-05-06-02 — GUI telemetry: Sentry crash-only, opt-in, cloud-default-on \/ self-hosted-default-off/,
    );
    expect(body).toMatch(
      /## D-2026-05-06-03 — GUI distribution: Tauri Updater \+ GitHub Releases \(cross-platform\)/,
    );
    expect(body).toMatch(
      /## D-2026-05-10-01 — OAuth 2\.0 third-party flow uses PKCE S256, confidential clients, opaque tokens \(no JWT\)/,
    );
  });

  it('pins the hosted OAuth human-consent boundary and safe registered callbacks', () => {
    expect(body).toMatch(/https:\/\/app\.driftstack\.io\/oauth\/authorize\//);
    expect(body).toMatch(/never directly to the provider-internal staging API/);
    expect(body).toMatch(/intermediate `authorization_id` remains provider-internal/);
    expect(body).toMatch(/bounded to 2,048 characters, reject userinfo and fragments/);
    expect(body).toMatch(/existing registered query is preserved safely/);
    expect(body).toMatch(/\*\*V-log:\*\* V-488, V-617, V-618, V-619, V-620, V-621\./);
  });

  it('pins bounded OAuth provider retention without deleting historical actor identities', () => {
    expect(body).toMatch(/One restart-safe hourly scheduled chain deletes provider authorizations/);
    expect(body).toMatch(/older than their five-minute validity/);
    expect(body).toMatch(/OAuth-token rows at or past their one-hour expiry/);
    expect(body).toMatch(/transaction-scoped PostgreSQL advisory lock/);
    expect(body).toMatch(/concurrent bootstrap replicas cannot seed parallel chains/);
    expect(body).toMatch(/ignore pending current\/older rows/);
    expect(body).toMatch(/legacy duplicate peer inserts one successor/);
    expect(body).toMatch(/every retry\/peer after that committed enqueue observes it/);
    expect(body).toMatch(/retains the expired backing `api_keys` actor rows/);
    expect(body).toMatch(/historical sessions and audit records may still reference those IDs/);
    expect(body).toMatch(/V-618, V-619, V-620, V-621/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
