// W527.A — drift guard for apps/admin-panel/astro.config.mjs.
// Driftstack-staff-only admin panel at admin.driftstack.dev. Drift here
// either changes the subdomain (would collapse the staff↔customer DNS
// security boundary) or breaks the V-134/V-174 staff-API-key scope
// requirement (would weaken staff access control) or breaks the V-200
// Cloudflare adapter (would 404 dynamic /accounts/[id] etc).
//
//   • Staff-only framing + admin.driftstack.dev (separate subdomain
//     from app.driftstack.dev customer dashboard so security boundary
//     is at DNS + TLS layer, not application logic).
//   • Auth: driftstack_internal_admin scope + /v1/admin/* control plane
//     + V-134 + V-174 preHandler enforcement.
//   • V-200 @astrojs/cloudflare adapter for dynamic detail routes
//     (e.g. /accounts/[id]).
//   • prerender=true (or unmarked under output:'static') → static HTML
//     to dist/; prerender=false → Worker at request time.
//   • platformProxy.enabled: false.
//   • Tailwind applyBaseStyles: false + inlineStylesheets: 'auto'.
//   • NO Sentry integration on admin-panel (unlike marketing-site +
//     customer-dashboard — staff-only surface intentionally excluded
//     from customer-facing error telemetry surfaces).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/astro.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W527.A apps/admin-panel/astro.config.mjs content parity', () => {
  const body = read(LIB);

  it("Staff-only + admin-subdomain + DNS-security-boundary framing pinned: 'Admin panel — Driftstack-staff-only surface.' + 'Lives at admin.driftstack.dev (separate subdomain from the customer dashboard at app.driftstack.dev) so security boundary is at the DNS + TLS layer, not application logic.' + 'site: https://admin.driftstack.dev' + 'output: \"static\"' — pinned so the staff-only-surface + admin-subdomain + DNS+TLS-security-boundary (not application-logic) commitment survives (drift to a different subdomain or merging into app. would collapse the staff↔customer security isolation)", () => {
    expect(body).toMatch(/\/\/ Admin panel — Driftstack-staff-only surface\./);
    expect(body).toMatch(
      /\/\/ Lives at admin\.driftstack\.dev \(separate subdomain from the customer\s*\n?\s*\/\/ dashboard at app\.driftstack\.dev\) so security boundary is at the DNS\s*\n?\s*\/\/ \+ TLS layer, not application logic\./,
    );
    expect(body).toMatch(/site: 'https:\/\/admin\.driftstack\.dev',/);
    expect(body).toMatch(/output: 'static',/);
  });

  it("V-134 + V-174 staff-scope framing pinned: 'Auth: Driftstack-staff API key with `driftstack_internal_admin` scope. Routes call /v1/admin/* on the control plane; preHandler enforced V-134 + V-174.' — pinned so the driftstack_internal_admin-scope + /v1/admin/* control-plane + V-134 + V-174 preHandler-enforcement commitment survives (drift to a different scope name would orphan the staff-API-key check; drift to bypassing /v1/admin/* would route admin actions through customer endpoints)", () => {
    expect(body).toMatch(
      /\/\/ Auth: Driftstack-staff API key with `driftstack_internal_admin`\s*\n?\s*\/\/ scope\. Routes call \/v1\/admin\/\* on the control plane; preHandler\s*\n?\s*\/\/ enforced V-134 \+ V-174\./,
    );
  });

  it("V-200 Cloudflare-adapter framing pinned: 'Cloudflare Pages with Workers — V-200 added the @astrojs/cloudflare adapter so dynamic detail routes (e.g. /accounts/[id]) can SSR for arbitrary live UUIDs. Pages with `prerender = true` (or unmarked in `output: \"static\"`) still emit static HTML to dist/. Pages with `prerender = false` are served by the Worker at request time and can fetch live data per request.' + cloudflare import + 'adapter: cloudflare({ platformProxy: { enabled: false } })' — pinned so the V-200 anchor + /accounts/[id]-example + prerender-true-static-vs-false-Worker routing + platformProxy-disabled commitment survives", () => {
    expect(body).toMatch(/import cloudflare from '@astrojs\/cloudflare';/);
    expect(body).toMatch(
      /\/\/ Cloudflare Pages with Workers — V-200 added the @astrojs\/cloudflare\s*\n?\s*\/\/ adapter so dynamic detail routes \(e\.g\. \/accounts\/\[id\]\) can SSR for\s*\n?\s*\/\/ arbitrary live UUIDs\. Pages with `prerender = true` \(or unmarked\s*\n?\s*\/\/ in `output: 'static'`\) still emit static HTML to dist\/\. Pages with\s*\n?\s*\/\/ `prerender = false` are served by the Worker at request time and\s*\n?\s*\/\/ can fetch live data per request\./,
    );
    expect(body).toMatch(
      /adapter: cloudflare\(\{\s*\n?\s*platformProxy: \{ enabled: false \},\s*\n?\s*\}\),/,
    );
  });

  it("Tailwind no-base-styles + inlineStylesheets framing pinned: '@ts-check' + 'integrations: [tailwind({ applyBaseStyles: false })]' (admin-panel does NOT pull Tailwind preflight; staff styles applied via admin src/styles) + 'inlineStylesheets: \"auto\"' build option — pinned so the JSDoc-typecheck + Tailwind-no-base-styles + inline-stylesheets-auto + single-integration-array (NO Sentry on admin-panel — staff-only surface intentionally excluded from customer-error-telemetry) commitment survives", () => {
    expect(body).toMatch(/\/\/ @ts-check/);
    expect(body).toMatch(/import tailwind from '@astrojs\/tailwind';/);
    expect(body).toMatch(/integrations: \[tailwind\(\{ applyBaseStyles: false \}\)\],/);
    expect(body).toMatch(/inlineStylesheets: 'auto',/);
    expect(body).not.toMatch(/import sentry from '@sentry\/astro';/);
    expect(body).not.toMatch(/sentry\(/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
