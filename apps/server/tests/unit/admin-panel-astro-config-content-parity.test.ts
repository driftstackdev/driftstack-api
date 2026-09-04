// W527.A — drift guard for apps/admin-panel/astro.config.mjs.
// Driftstack-staff-only admin panel at admin.driftstack.io. Drift here
// either changes the subdomain (would collapse the staff↔customer DNS
// security boundary) or breaks the V-134/V-174 staff-API-key scope
// requirement (would weaken staff access control) or drops the static
// arbitrary-ID shell contract (which would 404 live detail links).
//
//   • Staff-only framing + admin.driftstack.io (separate subdomain
//     from app.driftstack.io customer dashboard so security boundary
//     is at DNS + TLS layer, not application logic).
//   • Auth: driftstack_internal_admin scope + /v1/admin/* control plane
//     + V-134 + V-174 preHandler enforcement.
//   • Static output with `_redirects`-backed account/incident shells.
//   • Astro 7 compatibility compression + inlineStylesheets: 'auto'.
//   • Explicit Tailwind PostCSS pipeline, no framework integration.
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

  it("Staff-only + admin-subdomain + DNS-security-boundary framing pinned: 'Admin panel — Driftstack-staff-only surface.' + 'Lives at admin.driftstack.io (separate subdomain from the customer dashboard at app.driftstack.io) so security boundary is at the DNS + TLS layer, not application logic.' + 'site: https://admin.driftstack.io' + 'output: \"static\"' — pinned so the staff-only-surface + admin-subdomain + DNS+TLS-security-boundary (not application-logic) commitment survives (drift to a different subdomain or merging into app. would collapse the staff↔customer security isolation)", () => {
    expect(body).toMatch(/\/\/ Admin panel — Driftstack-staff-only surface\./);
    expect(body).toMatch(
      /\/\/ Lives at admin\.driftstack\.io \(separate subdomain from the customer\s*\/\/ dashboard at app\.driftstack\.io\) so security boundary is at the DNS\s*\/\/ \+ TLS layer, not application logic\./,
    );
    expect(body).toMatch(/site: 'https:\/\/admin\.driftstack\.io',/);
    expect(body).toMatch(/output: 'static',/);
  });

  it("V-134 + V-174 staff-scope framing pinned: 'Auth: Driftstack-staff API key with `driftstack_internal_admin` scope. Routes call /v1/admin/* on the control plane; preHandler enforced V-134 + V-174.' — pinned so the driftstack_internal_admin-scope + /v1/admin/* control-plane + V-134 + V-174 preHandler-enforcement commitment survives (drift to a different scope name would orphan the staff-API-key check; drift to bypassing /v1/admin/* would route admin actions through customer endpoints)", () => {
    expect(body).toMatch(
      /\/\/ Auth: Driftstack-staff API key with `driftstack_internal_admin`\s*\/\/ scope\. Routes call \/v1\/admin\/\* on the control plane; preHandler\s*\/\/ enforced V-134 \+ V-174\./,
    );
  });

  it('Static Cloudflare Pages framing pins URL-preserving detail-shell rewrites and forbids a Worker adapter', () => {
    expect(body).toMatch(
      /\/\/ Cloudflare Pages serves static output directly\. Arbitrary account and\s*\/\/ incident ids use `_redirects` 200 rewrites to deterministic client-fetched\s*\/\/ shells; no Worker\/SSR adapter is required\./,
    );
    expect(body).not.toMatch(/@astrojs\/cloudflare|adapter:/);
    expect(body).toMatch(/compressHTML: true,/);
  });

  it('pins typed static config, automatic inline styles, and the deliberate absence of framework integrations and Sentry', () => {
    expect(body).toMatch(/\/\/ @ts-check/);
    expect(body).not.toMatch(/@astrojs\/tailwind|integrations:/);
    expect(body).toMatch(/inlineStylesheets: 'auto',/);
    expect(body).not.toMatch(/import sentry from '@sentry\/astro';/);
    expect(body).not.toMatch(/sentry\(/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
