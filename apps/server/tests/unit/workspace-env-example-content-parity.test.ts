// W539.C — drift guard for /.env.example (workspace root).
// Local-dev .env template. Drift here either changes the DATABASE_URL
// fallback (would diverge from docker-compose driftstack/driftstack
// credentials), drops the V-266 DASHBOARD_ORIGIN anchor (would break
// the CLI-authorize browser_url construction), or accidentally flips
// AUTH_EXPOSE_DEBUG_TOKEN to false in dev (would break the
// scripts/dev-bootstrap.sh email-less auth-flow walkthrough).
//
//   • Server: NODE_ENV=development + PORT=3000 + LOG_LEVEL=debug +
//     HOST=0.0.0.0.
//   • Postgres URL with docker-compose 3-credential parity:
//     postgres://driftstack:driftstack@localhost:5432/driftstack.
//   • Redis URL: redis://localhost:6379.
//   • DRIVER=mock (production webkit driver "not yet implemented").
//   • Mock-driver latency tuning (V-mock anchors).
//   • V-079 auth-flow deep-link URLs (commented examples).
//   • AUTH_EXPOSE_DEBUG_TOKEN=true (dev only — prod MUST be false).
//   • V-266 DASHBOARD_ORIGIN=http://localhost:5173 for CLI-authorize
//     browser_url construction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.env.example');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W539.C /.env.example content parity', () => {
  const body = read(LIB);

  it("Header + Server-section framing pinned: '# Driftstack API — example env. Copy to .env for local dev.' + '# Server' + 'NODE_ENV=development' + 'PORT=3000' + 'LOG_LEVEL=debug' + 'HOST=0.0.0.0' — pinned so the dev-template-header + 4-server-var commitment survives (drift to PORT=7780 would diverge from the dev-default port; drift to HOST=127.0.0.1 would break container-to-host DB connectivity from compose)", () => {
    expect(body).toMatch(/# Driftstack API — example env\. Copy to \.env for local dev\./);
    expect(body).toMatch(/^# Server$/m);
    expect(body).toMatch(/^NODE_ENV=development$/m);
    expect(body).toMatch(/^PORT=3000$/m);
    expect(body).toMatch(/^LOG_LEVEL=debug$/m);
    expect(body).toMatch(/^HOST=0\.0\.0\.0$/m);
  });

  it("Postgres + Redis URL framing pinned: '# Postgres (matches docker-compose service)' + 'DATABASE_URL=postgres://driftstack:driftstack@localhost:5432/driftstack' + '# Redis (matches docker-compose service)' + 'REDIS_URL=redis://localhost:6379' — pinned so the docker-compose-credential-parity (driftstack/driftstack@localhost:5432/driftstack) + Redis-6379 commitment survives (drift to a different DATABASE_URL would force every dev to override their .env to connect to the compose service; drift to a different DB name would break the drizzle-kit migration runner)", () => {
    expect(body).toMatch(/# Postgres \(matches docker-compose service\)/);
    expect(body).toMatch(
      /^DATABASE_URL=postgres:\/\/driftstack:driftstack@localhost:5432\/driftstack$/m,
    );
    expect(body).toMatch(/# Redis \(matches docker-compose service\)/);
    expect(body).toMatch(/^REDIS_URL=redis:\/\/localhost:6379$/m);
  });

  it("Driver-selection + mock-latency framing pinned: '# Driver selection: \"mock\" (dev/test) or \"webkit\" (production; not yet implemented)' + 'DRIVER=mock' + '# Mock driver behaviour tuning (ms)' + 'MOCK_NAVIGATE_LATENCY_MS=120' + 'MOCK_INTERACT_LATENCY_MS=40' — pinned so the mock-default-dev + webkit-prod-NYI + 120/40 latency-tuning commitment survives (drift to DRIVER=webkit would attempt to load an unimplemented driver and crash on startup)", () => {
    expect(body).toMatch(
      /# Driver selection: "mock" \(dev\/test\) or "webkit" \(production; not yet implemented\)/,
    );
    expect(body).toMatch(/^DRIVER=mock$/m);
    expect(body).toMatch(/# Mock driver behaviour tuning \(ms\)/);
    expect(body).toMatch(/^MOCK_NAVIGATE_LATENCY_MS=120$/m);
    expect(body).toMatch(/^MOCK_INTERACT_LATENCY_MS=40$/m);
  });

  it("V-079 / V-079.C auth-flow deep-link URL framing pinned: V-079.C anchor + commented '# AUTH_VERIFY_EMAIL_URL=http://localhost:5173/verify-email' + commented '# AUTH_MAGIC_LINK_URL=http://localhost:5173/auth/magic-link' + commented '# AUTH_PASSWORD_RESET_URL=http://localhost:5173/reset-password' — V-079.C canonical paths (the legacy /auth/<flow> paths landed on 404s; fix landed 2026-05-12 when Postmark approval hit the first real customer's verify email)", () => {
    expect(body).toMatch(/V-079 \/ V-079\.C — auth-flow deep-link URLs/);
    expect(body).toMatch(/# AUTH_VERIFY_EMAIL_URL=http:\/\/localhost:5173\/verify-email/);
    expect(body).toMatch(/# AUTH_MAGIC_LINK_URL=http:\/\/localhost:5173\/auth\/magic-link/);
    expect(body).toMatch(/# AUTH_PASSWORD_RESET_URL=http:\/\/localhost:5173\/reset-password/);
    // 2026-05-12 incident provenance must be preserved.
    expect(body).toMatch(/2026-05-12/);
  });

  it("AUTH_EXPOSE_DEBUG_TOKEN + V-266 DASHBOARD_ORIGIN framing pinned: 'AUTH_EXPOSE_DEBUG_TOKEN — dev/test only. When true, signup / magic-link / password-reset responses include a `debug_token` plaintext field so dev scripts (scripts/dev-bootstrap.sh) can complete the flow without a wired email service. Production MUST leave this false.' + 'AUTH_EXPOSE_DEBUG_TOKEN=true' + 'V-266 — origin of the customer dashboard. Used to build the browser_url returned by /v1/auth/cli-authorize/initiate (browser-OAuth-style GUI activation). Override per environment.' + 'DASHBOARD_ORIGIN=http://localhost:5173' — pinned so the AUTH_EXPOSE_DEBUG_TOKEN-dev-only-prod-false + dev-bootstrap-script-anchor + V-266 CLI-authorize browser_url + per-env-override commitment survives (drift to AUTH_EXPOSE_DEBUG_TOKEN=true leaking into prod would expose plaintext tokens in API responses; drift to dropping DASHBOARD_ORIGIN would break /v1/auth/cli-authorize/initiate browser_url construction)", () => {
    expect(body).toMatch(
      /# AUTH_EXPOSE_DEBUG_TOKEN — dev\/test only\. When true, signup \/ magic-link \/\s*# password-reset responses include a `debug_token` plaintext field so dev\s*# scripts \(scripts\/dev-bootstrap\.sh\) can complete the flow without a\s*# wired email service\. Production MUST leave this false\./,
    );
    expect(body).toMatch(/^AUTH_EXPOSE_DEBUG_TOKEN=true$/m);
    expect(body).toMatch(
      /# V-266 — origin of the customer dashboard\. Used to build the browser_url\s*# returned by \/v1\/auth\/cli-authorize\/initiate \(browser-OAuth-style GUI\s*# activation\)\. Override per environment\./,
    );
    expect(body).toMatch(/^DASHBOARD_ORIGIN=http:\/\/localhost:5173$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
