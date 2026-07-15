// W615 — drift guard for the 3 remaining gap-audit close-outs:
//  - docs/deployment/dr-runbook.md (643 lines, V-199 standing DR procedures)
//  - docs/deployment/env-vars.md (338 lines, V-053 canonical env schema)
//  - .github/dependabot.yml (109 lines, V-105 weekly dependency updates)

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('W615 gap close-out content parity', () => {
  it('docs/deployment/dr-runbook.md: V-199 standing-procedures + 11-scenario layout (1 Hetzner-loss / 2 PG-corruption Neon-PITR / 3 PG-platform-outage / 4 Redis-Upstash-loss / 5 R2-loss / 6 compromised-key / 7 bad-deploy / 8 V-496 origin-TLS / 9 V-497 CF-Pages-rollback / 10 V-497 Stripe-secret-panic / 11 V-497 Hetzner-regional) + RTO/RPO table + dr-rehearse.sh V-510 harness + pre-launch dry-run checklist pinned', () => {
    const body = read('docs/deployment/dr-runbook.md');
    expect(body).toMatch(/^# Disaster recovery runbook$/m);
    expect(body).toMatch(/V-199 — standing procedures for recovering from the data-loss \//);
    expect(body).toMatch(/quick-triage flow in `docs\/deployment\/runbook\.md`/);
    expect(body).toMatch(/^## Scope \+ posture$/m);
    expect(body).toMatch(/^## Recovery time \+ point objectives$/m);
    expect(body).toMatch(/\| Hetzner host loss\s+\| < 30min \| 0\s+\|/);
    expect(body).toMatch(/\| Postgres logical corruption\s+\| < 2hr\s+\| < 5min\s+\|/);
    expect(body).toMatch(/\| Postgres \/ Neon platform outage\s+\| < 4hr\s+\| < 5min\s+\|/);
    expect(body).toMatch(/\| Redis loss\s+\| < 5min\s+\| n\/a\s+\|/);
    expect(body).toMatch(/\| Compromised signing key \/ secret\s+\| < 30min \| n\/a\s+\|/);
    expect(body).toMatch(/\| Bad deploy of broken code to prod \| < 15min \| 0\s+\|/);
    expect(body).toMatch(/\| Origin TLS certificate failure\s+\| < 1hr\s+\| n\/a\s+\|/);
    expect(body).toMatch(/^### Scenario 1 — Hetzner host loss$/m);
    expect(body).toMatch(/^### Scenario 2 — Postgres logical corruption \(Neon PITR\)$/m);
    expect(body).toMatch(
      /\*\*Concrete recovery commands\*\* \(V-496 expansion — copy\/paste-ready\):/,
    );
    expect(body).toMatch(/^### Scenario 3 — Postgres \/ Neon platform outage$/m);
    expect(body).toMatch(/^### Scenario 4 — Redis \(Upstash\) loss$/m);
    expect(body).toMatch(/^### Scenario 5 — R2 object loss$/m);
    expect(body).toMatch(/^### Scenario 6 — Compromised signing key \/ secret$/m);
    expect(body).toMatch(/Rotate at the upstream first\*\* to invalidate the old credential\./);
    expect(body).toMatch(/^### Scenario 7 — Bad deploy of broken code to prod$/m);
    expect(body).toMatch(/Roll back via git revert \+ redeploy\*\*, NOT via destructive/);
    expect(body).toMatch(/`git reset --hard`/);
    expect(body).toMatch(/^### Scenario 8 — Origin TLS certificate failure \(V-496 NEW\)$/m);
    expect(body).toMatch(/V-278\.M wired Let's Encrypt DNS-01 origin certs via `certbot` \+/);
    expect(body).toMatch(/`python3-certbot-dns-cloudflare`\. Certs auto-renew every ~60 days/);
    expect(body).toMatch(/^### Scenario 9 — Cloudflare Pages deploy regression \(V-497 NEW\)$/m);
    expect(body).toMatch(/\*\*RTO\*\*: 2 minutes \(single click in the dashboard\)\./);
    expect(body).toMatch(
      /^### Scenario 10 — Stripe webhook secret rotation under attack \(V-497 NEW\)$/m,
    );
    expect(body).toMatch(/^### Scenario 11 — Multi-day Hetzner regional outage \(V-497 NEW\)$/m);
    expect(body).toMatch(/Falkenstein region is unreachable for >12h\./);
    expect(body).toMatch(/^## Cross-cutting principles$/m);
    expect(body).toMatch(/Never reach for `git reset --hard` or `git push --force` to/);
    expect(body).toMatch(/^## Pre-launch dry-run checklist$/m);
    expect(body).toMatch(/`scripts\/dr-rehearse\.sh` \(V-510\)/);
    expect(body).toMatch(/walks the scenarios that don't need production touchpoints/);
    expect(body).toMatch(/^## Related$/m);
    expect(body).toMatch(
      /Operational runbook \(incident triage\): `docs\/deployment\/runbook\.md`/,
    );
    expect(body).toMatch(/Env-var schema: `docs\/deployment\/env-vars\.md`/);
    expect(existsSync(resolve(REPO_ROOT, 'docs/deployment/dr-runbook.md'))).toBe(true);
  });

  it('docs/deployment/env-vars.md: canonical mode-600 runtime schema + recurring Stripe catalog + validation workflow pinned', () => {
    const body = read('docs/deployment/env-vars.md');
    expect(body).toMatch(/^# Driftstack control plane — environment variables$/m);
    expect(body).toMatch(/SSH-only, root-owned/);
    expect(body).toMatch(/`\/opt\/driftstack\/api\/\.env`/);
    expect(body).toMatch(/owner `driftstack:driftstack`/);
    expect(body).toMatch(/`deploy-bridge\.sh` promotions preserve/);
    expect(body).toMatch(
      /\*\*Effective:\*\* 2026-07-15 · \*\*Version:\*\* 1\.0\.0 · \*\*V-053\*\*/,
    );
    expect(body).toMatch(/^## Conventions$/m);
    expect(body).toMatch(/^## Variables$/m);
    expect(body).toMatch(/^### Process \/ runtime$/m);
    expect(body).toMatch(/`NODE_ENV`\s+\| yes\s+\| per-env\s+\| `production`/);
    expect(body).toMatch(/`PORT`\s+\| optional \| shared\s+\| `7780`/);
    expect(body).toMatch(/`LOG_LEVEL`/);
    expect(body).toMatch(/`DRIVER`\s+\| optional \| per-env\s+\| `mock`/);
    expect(body).toMatch(/^### Postgres \(Neon, EU Frankfurt\)$/m);
    expect(body).toMatch(/^### Redis \(Upstash, EU Frankfurt\)$/m);
    expect(body).toMatch(/^### Mock-driver tuning \(test \/ dev only\)$/m);
    expect(body).toMatch(/^### Slow-query log \(Postgres observability\)$/m);
    expect(body).toMatch(/`SLOW_QUERY_LOG_THRESHOLD_MS`/);
    expect(body).toMatch(/^### Cloudflare R2 \(object storage, EU jurisdiction\)$/m);
    expect(body).toMatch(/^### Postmark \(transactional email, EU sending region\)$/m);
    expect(body).toMatch(/^### Sentry \(error tracking, EU region\)$/m);
    expect(body).toMatch(/^### Stripe \(payment processing — fiat only at launch\)$/m);
    expect(body).toMatch(
      /Per V-052: Stripe is the sole payment rail\. Coinbase Commerce dropped\./,
    );
    expect(body).toMatch(/`STRIPE_PUBLISHABLE_KEY`/);
    expect(body).toMatch(/`DRIFTSTACK_TIER_PRICE_IDS`/);
    expect(body).toMatch(/six products \/ twelve recurring prices/);
    expect(body).not.toMatch(/STRIPE_TRIAL_PACK_PRICE_ID|19 IDs per ADR-004/);
    expect(body).not.toMatch(
      /ANTHROPIC_API_KEY|MONEYBIRD_API_TOKEN|MONEYBIRD_ADMINISTRATION_ID|BV_LEGAL_NAME|BV_KVK_NUMBER|BV_BTW_NUMBER|BV_REGISTERED_ADDRESS/,
    );
    expect(body).toMatch(/^### Marketing site \(Cloudflare Pages — build-time only\)$/m);
    expect(body).toMatch(/^### Customer dashboard \(Cloudflare Pages — build-time only\)$/m);
    expect(body).toMatch(/^### User-facing auth flow \(V-079\)$/m);
    expect(body).toMatch(/`DASHBOARD_ORIGIN`/);
    expect(body).toMatch(
      /Production refuses to boot if any resolved URL still contains `localhost`/,
    );
    expect(body).toMatch(/W190: trailing slashes are stripped at the schema layer/);
    expect(body).toMatch(/`AUTH_VERIFY_EMAIL_URL`/);
    expect(body).toMatch(/`AUTH_MAGIC_LINK_URL`/);
    expect(body).toMatch(/`AUTH_PASSWORD_RESET_URL`/);
    expect(body).toMatch(/`AUTH_EXPOSE_DEBUG_TOKEN`/);
    expect(body).not.toMatch(/Future Workstream slots|placeholder — not yet wired/);
    expect(body).not.toMatch(/JWT_SIGNING_KEY_KID|FLEET_NODE_PUBLIC_KEY_CACHE_TTL_SECONDS/);
    expect(body).toMatch(/^## Per-environment baseline$/m);
    expect(body).toMatch(/^## How the production runtime file gets populated$/m);
    expect(body).toMatch(/root-owned mode-600 pending path/);
    expect(body).toMatch(/DEPLOY_VIA_BUNDLE=1 scripts\/deploy-bridge\.sh/);
    expect(body).toMatch(/^## Validation checklist$/m);
    expect(body).toMatch(/`DATABASE_URL` ends with `\?sslmode=require` \(Neon enforces TLS\)/);
    expect(body).toMatch(/`REDIS_URL` uses `rediss:\/\/` not `redis:\/\/` \(Upstash TLS\)/);
    expect(body).toMatch(/`SENTRY_DSN` contains `\.de\.` for EU region\./);
    expect(body).toMatch(/^## Updating this doc$/m);
    expect(body).toMatch(/`apps\/server\/src\/lib\/config\.ts`/);
    expect(existsSync(resolve(REPO_ROOT, 'docs/deployment/env-vars.md'))).toBe(true);
  });

  it('.github/dependabot.yml: V-105 weekly Monday-04:00 Europe/Amsterdam updates + 5 ecosystems (npm root + pip sdk-python + gomod sdk-go + cargo gui-client/src-tauri + github-actions) + 4-group npm pattern (types + dev-deps-minor-patch + runtime-deps-patch + runtime-deps-minor) + locked-stack-no-grouped-majors (drizzle-orm + drizzle-kit + fastify + ioredis + postgres) + no-auto-merge-here policy pinned', () => {
    const body = read('.github/dependabot.yml');
    expect(body).toMatch(/^# Dependabot configuration \(V-105\)\.$/m);
    expect(body).toMatch(/^# Schedules weekly automated update PRs across the five ecosystems$/m);
    expect(body).toMatch(/^# we run \(npm root \+ each workspace, pip Python SDK, gomod Go SDK,$/m);
    expect(body).toMatch(/^# cargo Tauri GUI, github-actions workflows\)\./m);
    expect(body).toMatch(/Minor\/patch bumps within an/);
    expect(body).toMatch(/ecosystem are grouped into a single PR per week to reduce review/);
    expect(body).toMatch(/major bumps land as individual PRs because they typically/);
    expect(body).toMatch(/^# Auto-merge is NOT configured here — every PR goes through review\.$/m);
    expect(body).toMatch(/^version: 2$/m);
    expect(body).toMatch(/^updates:$/m);
    expect(body).toMatch(/^\s+- package-ecosystem: npm$/m);
    expect(body).toMatch(/^\s+directory: \/$/m);
    expect(body).toMatch(/^\s+interval: weekly$/m);
    expect(body).toMatch(/^\s+day: monday$/m);
    expect(body).toMatch(/^\s+time: '04:00'$/m);
    expect(body).toMatch(/^\s+timezone: Europe\/Amsterdam$/m);
    expect(body).toMatch(/^\s+open-pull-requests-limit: 5$/m);
    expect(body).toMatch(/^\s+versioning-strategy: increase$/m);
    expect(body).toMatch(/^\s+types:$/m);
    expect(body).toMatch(/^\s+applies-to: version-updates$/m);
    expect(body).toMatch(/^\s+patterns:$/m);
    expect(body).toMatch(/^\s+- '@types\/\*'$/m);
    expect(body).toMatch(/^\s+update-types: \[minor, patch\]$/m);
    expect(body).toMatch(/^\s+dev-deps-minor-patch:$/m);
    expect(body).toMatch(/^\s+dependency-type: development$/m);
    expect(body).toMatch(/^\s+runtime-deps-patch:$/m);
    expect(body).toMatch(/^\s+dependency-type: production$/m);
    expect(body).toMatch(/^\s+update-types: \[patch\]$/m);
    expect(body).toMatch(/^\s+runtime-deps-minor:$/m);
    expect(body).toMatch(/^\s+update-types: \[minor\]$/m);
    expect(body).toMatch(/Locked stack — bumps surface as architectural decisions/);
    expect(body).toMatch(/^\s+- dependency-name: drizzle-orm$/m);
    expect(body).toMatch(/^\s+update-types: \[version-update:semver-major\]$/m);
    expect(body).toMatch(/^\s+- dependency-name: drizzle-kit$/m);
    expect(body).toMatch(/^\s+- dependency-name: fastify$/m);
    expect(body).toMatch(/^\s+- dependency-name: ioredis$/m);
    expect(body).toMatch(/^\s+- dependency-name: postgres$/m);
    expect(body).toMatch(/^\s+- package-ecosystem: pip$/m);
    expect(body).toMatch(/^\s+directory: \/packages\/sdk-python$/m);
    expect(body).toMatch(/^\s+open-pull-requests-limit: 3$/m);
    expect(body).toMatch(/^\s+python-dev-deps:$/m);
    expect(body).toMatch(/^\s+python-runtime-patch:$/m);
    expect(body).toMatch(/^\s+- package-ecosystem: cargo$/m);
    expect(body).toMatch(/^\s+directory: \/apps\/gui-client\/src-tauri$/m);
    expect(body).toMatch(/^\s+cargo-minor-patch:$/m);
    expect(body).toMatch(/^\s+- package-ecosystem: gomod$/m);
    expect(body).toMatch(/^\s+directory: \/packages\/sdk-go$/m);
    expect(body).toMatch(/^\s+gomod-minor-patch:$/m);
    expect(body).toMatch(/^\s+- package-ecosystem: github-actions$/m);
    expect(body).toMatch(/^\s+gha-minor-patch:$/m);
    expect(existsSync(resolve(REPO_ROOT, '.github/dependabot.yml'))).toBe(true);
  });
});
