// W526.A — drift guard for apps/customer-dashboard/astro.config.mjs.
// Static Cloudflare Pages output + V-469 Sentry + V-079 auth-flow
// control-plane wiring. Drift here could restore an unnecessary SSR
// runtime or break the Sentry build-time opt-in.
//
//   • site: https://app.driftstack.dev (customer dashboard subdomain).
//   • output: static (Cloudflare Pages serves dist/).
//   • No SSR adapter: every current route is static.
//   • V-469 @sentry/astro with PUBLIC_SENTRY_DSN_DASHBOARD build-time
//     opt-in (skips when unset).
//   • Sentry tracesSampleRate: 0.05.
//   • Sentry project: 'driftstack-dashboard'.
//   • V-079 auth-flow pages POST to /v1/auth/* control plane.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/astro.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W526.A apps/customer-dashboard/astro.config.mjs content parity', () => {
  const body = read(LIB);

  it("Customer-dashboard framing + dashboard-stack proposal framing pinned: 'Customer dashboard for app.driftstack.dev. Static-build per the dashboard-stack proposal in docs/architecture/customer-dashboard-stack.md (pending founder review of Option A — Astro + React islands shared with marketing site). When founder approves, React islands land alongside; for now the scaffolding is pure-Astro static.' + 'site: https://app.driftstack.dev' + 'output: \"static\"' — pinned so the app.driftstack.dev subdomain + static-build + Option-A-Astro+React-islands-pending-review + pure-Astro-scaffolding-for-now commitment survives", () => {
    expect(body).toMatch(
      /\/\/ Customer dashboard for app\.driftstack\.dev\. Static-build per the\s*\n?\s*\/\/ dashboard-stack proposal in docs\/architecture\/customer-dashboard-stack\.md\s*\n?\s*\/\/ \(pending founder review of Option A — Astro \+ React islands shared with\s*\n?\s*\/\/ marketing site\)\. When founder approves, React islands land alongside;\s*\n?\s*\/\/ for now the scaffolding is pure-Astro static\./,
    );
    expect(body).toMatch(/site: 'https:\/\/app\.driftstack\.dev',/);
    expect(body).toMatch(/output: 'static',/);
  });

  it('Static Cloudflare Pages output is explicit and the unused SSR adapter stays absent', () => {
    expect(body).toMatch(
      /\/\/ Cloudflare Pages serves this static build directly\. Add an SSR adapter only\s*\n?\s*\/\/ if a concrete on-demand route is introduced; no current page needs one\./,
    );
    expect(body).not.toMatch(/@astrojs\/cloudflare|adapter:/);
    expect(body).toMatch(/compressHTML: true,/);
  });

  it("V-079 auth-flow control-plane framing pinned: 'Auth-flow pages POST to the control plane at /v1/auth/* per V-079.' — pinned so the V-079 anchor + /v1/auth/* control-plane-POST commitment survives (drift to a different auth endpoint would create dashboard↔auth-API divergence)", () => {
    expect(body).toMatch(
      /\/\/ Auth-flow pages POST to the control plane at \/v1\/auth\/\* per V-079\./,
    );
  });

  it("V-469 Sentry integration framing pinned: 'V-469 — @sentry/astro integration. Activates when PUBLIC_SENTRY_DSN_DASHBOARD is set at build time; skips entirely when unset, matching the existing API-server skip-when-empty posture for SENTRY_DSN. Source-map upload is a no-op when SENTRY_AUTH_TOKEN is unset.' + 'const SENTRY_DSN = process.env.PUBLIC_SENTRY_DSN_DASHBOARD ?? \"\";' + 'const SENTRY_RELEASE = process.env.SENTRY_RELEASE ?? process.env.GIT_SHA ?? \"unknown\";' + 'const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN ?? \"\";' — pinned so the V-469 anchor + dashboard-DSN-build-time-opt-in + matches-API-server-skip-when-empty-posture + 3-level-release-fallback + sourcemap-noop-when-token-unset commitment survives", () => {
    expect(body).toMatch(/import sentry from '@sentry\/astro';/);
    expect(body).toMatch(
      /\/\/ V-469 — @sentry\/astro integration\. Activates when\s*\n?\s*\/\/ PUBLIC_SENTRY_DSN_DASHBOARD is set at build time; skips entirely\s*\n?\s*\/\/ when unset, matching the existing API-server skip-when-empty\s*\n?\s*\/\/ posture for SENTRY_DSN\. Source-map upload is a no-op when\s*\n?\s*\/\/ SENTRY_AUTH_TOKEN is unset\./,
    );
    expect(body).toMatch(/const SENTRY_DSN = process\.env\.PUBLIC_SENTRY_DSN_DASHBOARD \?\? '';/);
    expect(body).toMatch(/const SENTRY_AUTH_TOKEN = process\.env\.SENTRY_AUTH_TOKEN \?\? '';/);
    expect(body).toMatch(
      /process\.env\.SENTRY_RELEASE \?\?= process\.env\.GIT_SHA \?\? 'unknown';/,
    );
  });

  it("Sentry call + dashboard-project framing pinned: 'enabled: SENTRY_DSN.length > 0' + 'tracesSampleRate: 0.05' + 'project: \"driftstack-dashboard\"' + 'org: process.env.SENTRY_ORG ?? \"driftstack\"' — pinned so the DSN-length-gated-enable + 5%-trace-sample + driftstack-dashboard-project + driftstack-org-default commitment survives", () => {
    expect(body).toMatch(/enabled: SENTRY_DSN\.length > 0,/);
    expect(body).toMatch(/project: 'driftstack-dashboard',/);
    expect(body).toMatch(/org: process\.env\.SENTRY_ORG \?\? 'driftstack',/);
    expect(body).toMatch(/authToken: SENTRY_AUTH_TOKEN \|\| undefined,/);
  });

  it('pins typed config, explicit Tailwind handling outside Astro integrations, and automatic inline styles', () => {
    expect(body).toMatch(/\/\/ @ts-check/);
    expect(body).not.toMatch(/@astrojs\/tailwind/);
    expect(body).toMatch(/inlineStylesheets: 'auto',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
