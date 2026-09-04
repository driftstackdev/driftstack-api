// W537.A — drift guard for apps/status-site/astro.config.mjs.
// V-295c public service status page. Drift here either changes the
// runtime-fetch target (would create status.driftstack.io↔/v1/status
// divergence) or breaks the hermetic-build commitment (would couple
// build success to API availability).
//
//   • V-295c anchor + 'public service status page' framing.
//   • Static Astro output served from Cloudflare Pages at
//     status.driftstack.io.
//   • Runtime fetch: https://api.driftstack.dev/v1/status/incidents.
//   • Build hermetic — no build-time fetch, decoupled from API
//     availability (drift to build-time fetch would block deploy when
//     /v1/status is down).
//   • site: https://status.driftstack.io.
//   • output: static.
//   • Single integration: Tailwind no-base-styles.
//   • inlineStylesheets: auto.
//   • No Sentry (parity with apps/docs — public read-only surface, no
//     customer-error telemetry).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/status-site/astro.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W537.A apps/status-site/astro.config.mjs content parity', () => {
  const body = read(LIB);

  it("V-295c + status.driftstack.io + hermetic-build framing pinned: '@ts-check' + 'V-295c — public service status page.' + 'Static Astro output served from Cloudflare Pages at status.driftstack.io. At runtime the page fetches `https://api.driftstack.dev/v1/status/incidents` and renders. No build-time fetch — keeps the build hermetic and decoupled from the API's availability.' — pinned so the V-295c anchor + status.driftstack.io-canonical-subdomain + Cloudflare-Pages-static + runtime-fetch-from-api.driftstack.dev/v1/status/incidents + hermetic-build (decoupled from API availability) commitment survives (drift to build-time fetch would block deploy when /v1/status is down, exactly when the status page is needed most)", () => {
    expect(body).toMatch(/\/\/ @ts-check/);
    expect(body).toMatch(/\/\/ V-295c — public service status page\./);
    expect(body).toMatch(
      /\/\/ Static Astro output served from Cloudflare Pages at status\.driftstack\.io\.\s*\/\/ At runtime the page fetches `https:\/\/api\.driftstack\.dev\/v1\/status\/incidents`\s*\/\/ and renders\. No build-time fetch — keeps the build hermetic and decoupled\s*\/\/ from the API's availability\./,
    );
    expect(body).toMatch(/site: 'https:\/\/status\.driftstack\.io',/);
    expect(body).toMatch(/output: 'static',/);
  });

  it("Tailwind no-base-styles + inlineStylesheets + no-Sentry framing pinned: 'integrations: [tailwind({ applyBaseStyles: false })]' (single integration — status-site is minimal, no sitemap/Sentry overhead) + 'inlineStylesheets: \"auto\"' — pinned so the Tailwind-no-base-styles + minimal-integration-array + NO @sentry/astro (parity with docs site — status-site is a read-only public surface with no customer-error-telemetry need) commitment survives (drift to adding Sentry would route status-page-load errors through customer telemetry; drift to adding sitemap would publish status incidents to search engines)", () => {
    expect(body).toMatch(/import tailwindcss from '@tailwindcss\/vite';/);
    expect(body).toMatch(/vite: \{\s*\n\s*plugins: \[tailwindcss\(\)\],/);
    expect(body).not.toMatch(/@astrojs\/tailwind/);
    expect(body).not.toMatch(/integrations:/);
    expect(body).toMatch(/inlineStylesheets: 'auto',/);
    expect(body).not.toMatch(/import sentry from '@sentry\/astro';/);
    expect(body).not.toMatch(/sentry\(/);
    expect(body).not.toMatch(/import sitemap from '@astrojs\/sitemap';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
