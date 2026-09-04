// W812 — perf/README.md + infra/README.md content parity. One-
// hundred-thirty-eighth in the drift-guard series. Pins the two
// remaining unguarded top-level READMEs:
//
//   perf/README.md   — 3-scenario load-test catalogue + pass criteria.
//   infra/README.md  — V-278 deployment cycle + 7-sub-processor map
//                      + credential-handling LIVE-vs-TEST boundary.
//
// Drift in either would either lose perf-regression definitions or
// break the credential-handling memory rule that gates live-mode
// secrets behind SSH-write-only.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PERF = resolve(REPO_ROOT, 'perf/README.md');
const INFRA = resolve(REPO_ROOT, 'infra/README.md');

describe('W812 perf + infra README content parity', () => {
  it('both READMEs exist at canonical paths', () => {
    expect(existsSync(PERF)).toBe(true);
    expect(existsSync(INFRA)).toBe(true);
  });

  // ─── perf/README.md ───────────────────────────────────────────

  it("CRITICAL perf/README header framing pinned. The 'Phase 9 performance + memory-leak harness' + 'boot the same Fastify app the e2e suite uses (Drizzle + Redis)' wording is the load-bearing 'this harness matches production shape' anchor.", () => {
    const p = read(PERF);
    expect(p).toMatch(/^# Perf harness$/m);
    expect(p).toMatch(/Phase 9 performance \+ memory-leak harness\./);
    expect(p).toMatch(
      /All scripts boot the same Fastify app the e2e suite uses \(Drizzle \+ Redis\)/,
    );
    expect(p).toMatch(/seed a single test account, and drive load via \[`autocannon`\]/);
  });

  it('CRITICAL perf/README 3-scenario markdown table pinned — sustained.ts (100 RPS mixed, 5 min) + burst.ts (1000 RPS GET-heavy, 60 s) + soak.ts (30 RPS mixed, 1 h memory-leak detector). Matches W805 perf/ harness coverage.', () => {
    const p = read(PERF);
    expect(p).toMatch(/\| `perf\/sustained\.ts` \| 100 RPS mixed read\/write \| 5 min default/);
    expect(p).toMatch(/\| `perf\/burst\.ts` +\| 1000 RPS GET-heavy +\| 60 s default/);
    expect(p).toMatch(
      /\| `perf\/soak\.ts` +\| 30 RPS mixed +\| 1 h default +\| memory-leak detector\./,
    );
  });

  it('CRITICAL perf/README pass-criteria framing pinned cross-script. Sustained: p99 < 250 ms + error rate (excluding 429) = 0; Burst: no 5xx + p99 may degrade to 1 s; Soak: no metric > 1.5× first-quarter avg + no 5xx. Matches W805 evaluatePass thresholds.', () => {
    const p = read(PERF);
    expect(p).toMatch(
      /\*\*Sustained 100 RPS:\*\* p99 < 250 ms, error rate \(excluding 429\) = 0\./,
    );
    expect(p).toMatch(/\*\*Burst 1000 RPS:\*\* no 5xx, p99 may degrade to 1 s\./);
    expect(p).toMatch(
      /\*\*Soak 1 h @ 30 RPS:\*\* no metric > 1\.5× its first-quarter average, no 5xx\./,
    );
  });

  it('CRITICAL perf/README 4-run-command examples pinned — sustained (default + --duration 30 smoke) + burst + soak (default + --duration 60 smoke). Drift would lose the canonical npx-tsx invocations.', () => {
    const p = read(PERF);
    expect(p).toMatch(/npx tsx perf\/sustained\.ts +# 5 min @ 100 RPS/);
    expect(p).toMatch(/npx tsx perf\/sustained\.ts --duration 30 +# short smoke \(30 s\)/);
    expect(p).toMatch(/npx tsx perf\/burst\.ts +# 60 s @ 1000 RPS/);
    expect(p).toMatch(/npx tsx perf\/soak\.ts +# 1 h @ 30 RPS/);
    expect(p).toMatch(/npx tsx perf\/soak\.ts --duration 60 +# short smoke \(60 s\)/);
  });

  it("CRITICAL perf/README 'What's NOT measured' framing pinned — real WebKit driver / multi-instance Redis cluster / Postgres replication lag. The explicit non-coverage list prevents claims-too-far drift in customer-facing perf docs.", () => {
    const p = read(PERF);
    expect(p).toMatch(/## What's NOT measured/);
    expect(p).toMatch(/Real WebKit driver latency — Phase 9 still runs the mock driver/);
    expect(p).toMatch(/Multi-instance Redis cluster behaviour — single-instance Redis/);
    expect(p).toMatch(/Postgres replication lag, etc\. — single-instance Postgres\./);
  });

  it("CRITICAL perf/README docker-compose-up pre-step pinned. The 'Bring up infra: docker compose up -d' instruction is what makes the perf harness self-contained — drift would let perf runs silently use stale state.", () => {
    const p = read(PERF);
    expect(p).toMatch(/# Bring up infra\s*\ndocker compose up -d/);
  });

  // ─── infra/README.md ──────────────────────────────────────────

  it('CRITICAL infra/README V-278 anchor + layout-tree pinned. The ASCII tree (bootstrap/ + env-templates/ + nginx/ + systemd/ + hetzner/) documents the canonical 5-dir layout; drift would either orphan files or break the deploy script paths.', () => {
    const p = read(INFRA);
    expect(p).toMatch(/V-278 Hetzner deployment artifacts\./);
    expect(p).toMatch(/├── bootstrap\//);
    expect(p).toMatch(/│ +├── bootstrap\.sh +Run-once host bootstrap \(Ubuntu 24\.04\)/);
    expect(p).toMatch(/│ +└── deploy-api\.sh +Deploy the Fastify API to a host \(V-278\.B\)/);
    expect(p).toMatch(/├── env-templates\//);
    expect(p).toMatch(/├── nginx\//);
    expect(p).toMatch(/├── systemd\//);
    expect(p).toMatch(/└── hetzner\//);
  });

  it('CRITICAL infra/README 12-slice V-278 deployment cycle table pinned — A/B/C/D/E/F/G/H/I/J/K/L. Each slice maps to a distinct V-278 sub-slice; drift would lose the canonical lifecycle anchor.', () => {
    const p = read(INFRA);
    expect(p).toMatch(
      /V-278\.A \| Bootstrap both servers via `bootstrap\/bootstrap\.sh production`/,
    );
    expect(p).toMatch(/V-278\.B \| Deploy api\.driftstack\.dev → production/);
    expect(p).toMatch(/V-278\.C \| Deploy app\.driftstack\.io → production/);
    expect(p).toMatch(/V-278\.D \| Deploy docs\.driftstack\.io/);
    expect(p).toMatch(/V-278\.E \| Deploy driftstack\.io root/);
    expect(p).toMatch(/V-278\.F \| Deploy staging\.driftstack\.dev/);
    expect(p).toMatch(/V-278\.G \| Run migrations on Neon Postgres \(`drizzle-kit migrate`\)\./);
    expect(p).toMatch(/V-278\.H \| DNS records via Cloudflare API\./);
    expect(p).toMatch(/V-278\.I \| Smoke-test all public URLs\./);
    expect(p).toMatch(/V-278\.J \| Sentry per-service DSN wiring/);
    expect(p).toMatch(
      /V-278\.K \| Post-launch — split Neon \+ Upstash into separate prod\/staging projects\./,
    );
    expect(p).toMatch(/V-278\.L \| Post-launch — create dedicated Sentry projects/);
  });

  it("CRITICAL infra/README TLS strategy framing pinned. 'Cloudflare proxied + Universal SSL (publicly-trusted, auto-issued, auto-renewed). Origin nginx serves plaintext HTTP on port 80; the Cloudflare zone is configured for \"Full (strict)\" SSL/TLS. No certbot / Let's Encrypt at the origin layer for v1.0.' Note: this contradicts W806 nginx vhosts which DO use Let's Encrypt; the README documents the V-278.M update boundary.", () => {
    const p = read(INFRA);
    expect(p).toMatch(/## TLS strategy/);
    expect(p).toMatch(
      /Cloudflare proxied \+ Universal SSL \(publicly-trusted, auto-issued,\s*\nauto-renewed\)/,
    );
    expect(p).toMatch(/the\s*\nCloudflare zone is configured for "Full \(strict\)" SSL\/TLS/);
  });

  it('CRITICAL infra/README 7-sub-processor map pinned — Hetzner Cloud (NBG1/FSN1) + Neon (Frankfurt) + Upstash + Cloudflare + Postmark (US) + Sentry (DE/EU) + Stripe (US, EU subsidiary). Matches V-271 check-subprocessor-mirror enforcement (W808).', () => {
    const p = read(INFRA);
    expect(p).toMatch(
      /\*\*Hetzner Cloud\*\* \(Nuremberg NBG1 \/ Falkenstein FSN1\) — VM compute\./,
    );
    expect(p).toMatch(/\*\*Neon\*\* \(Frankfurt eu-central-1\) — managed Postgres 17\./);
    expect(p).toMatch(/\*\*Upstash\*\* \(eu-central\) — managed Redis 7\./);
    expect(p).toMatch(
      /\*\*Cloudflare\*\* \(global, EU-jurisdiction R2\) — DNS \/ CDN \/ R2 \/ WAF\./,
    );
    expect(p).toMatch(
      /\*\*Postmark\*\* \(US\) — transactional email; sender domain DKIM-verified\./,
    );
    expect(p).toMatch(/\*\*Sentry\*\* \(DE \/ EU region\) — error tracking \+ release tracking\./);
    expect(p).toMatch(/\*\*Stripe\*\* \(US, EU subsidiary for SCA\) — payment processing\./);
  });

  it("CRITICAL infra/README sub-processor enforcement cross-link pinned. The 'scripts/check-subprocessor-mirror.mjs enforces public ↔ DPA Annex 3 sync; CI fails when env templates introduce a new sub-processor without the matching DPA + sub-processors.json update' wording threads the V-271 + V-264 + V-255 lockstep.", () => {
    const p = read(INFRA);
    expect(p).toMatch(
      /`scripts\/check-subprocessor-mirror\.mjs` enforces public ↔ DPA Annex 3\s*\nsync/,
    );
    expect(p).toMatch(
      /CI fails when env templates introduce a new sub-processor without\s*\nthe matching DPA \+ sub-processors\.json update\./,
    );
  });

  it("CRITICAL infra/README credential-handling LIVE-vs-TEST boundary pinned. The 'TEST-mode secrets may be committed via DEPLOY_DOTENV_BASE64' + 'LIVE-mode secrets written via SSH directly to /opt/driftstack/api/.env on the host. They never pass through the agent's chat history or pull-request artifacts' wording is the load-bearing credential-memory-rule anchor.", () => {
    const p = read(INFRA);
    expect(p).toMatch(/## Credential handling/);
    expect(p).toMatch(
      /\*\*TEST-mode secrets\*\* \(Stripe `sk_test_`, Postmark dev tokens\) may be\s*\n {2}committed via base64 in `DEPLOY_DOTENV_BASE64` GitHub secret\./,
    );
    expect(p).toMatch(
      /\*\*LIVE-mode secrets\*\* \(Stripe `sk_live_`, post-KvK\) are written via\s*\n {2}SSH directly to `\/opt\/driftstack\/api\/\.env` on the host\. They never\s*\n {2}pass through the agent's chat history or pull-request artifacts\./,
    );
  });

  it('CRITICAL infra/README DPA Annex 3 cross-link pinned to ../apps/marketing-site/src/pages/legal/dpa.md path. Drift to a different DPA file path would break the V-271 sub-processor parity gate.', () => {
    const p = read(INFRA);
    expect(p).toMatch(/\[DPA Annex 3\]\(\.\.\/apps\/marketing-site\/src\/pages\/legal\/dpa\.md\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/perf-and-infra-readme-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
