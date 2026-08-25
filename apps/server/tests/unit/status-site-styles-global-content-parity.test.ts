// Drift guard for apps/status-site/src/styles/global.css. Pins the
// Fleet two-axis framing + the F-1 mobile-scroll prevention.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/styles/global.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('status-site styles/global content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Tailwind v4 @import header pinned (W368 — replaces the v3 3-directive header)', () => {
    expect(body).toMatch(/@import 'tailwindcss';/);
  });

  it("Fleet two-axis framing pinned: status synced with the light-first product — 'Customers checking status during an incident see the same brand surface as driftstack.dev.' Drift to a different theme would create a brand-jarring mid-incident UX", () => {
    expect(body).toMatch(/Fleet rework \(2026-06-12\) — status-site synced with marketing-site \+/);
    expect(body).toMatch(/customer-dashboard: light\+violet default/);
    expect(body).toMatch(
      /Customers\s*checking status during an incident see the same brand surface as\s*driftstack\.dev\./,
    );
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*color-scheme: dark;/);
  });

  it('Geist font + bg-surface-base/text-ink-primary tokens pinned: cross-app shared brand tokens. Drift would break consistency with the other 3 dark-mode apps', () => {
    expect(body).toMatch(/font-family: Geist, ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/@apply bg-surface-base text-ink-primary;/);
  });

  it('F-1 iPhone-Safari horizontal-scroll prevention pinned: overflow-x:clip on html + body + max-width:100vw. Drift would break sticky positioning on the status site (where during outages people may bookmark the page on mobile)', () => {
    expect(body).toMatch(/F-1 — prevent iPhone Safari horizontal scroll/);
    expect(body).toMatch(/overflow-x: clip;/);
    expect(body).toMatch(/max-width: 100vw;/);
  });

  it('Code-block wrap/break-word + pre overflow-x:auto pinned: drift would break long-URL/long-error-string rendering in incident detail pages (common content in status updates)', () => {
    expect(body).toMatch(/overflow-wrap: anywhere;/);
    expect(body).toMatch(/word-break: break-word;/);
    expect(body).toMatch(
      /pre \{\s*\/\* F-1 — code blocks scroll internally rather than pushing page\. \*\/\s*overflow-x: auto;\s*\}|pre \{\s*overflow-x: auto;\s*\}/,
    );
  });
});
