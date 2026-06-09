// Drift guard for apps/status-site/src/styles/global.css. Pins the
// R13 dark-mode-synced framing + the F-1 mobile-scroll prevention.

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

  it("R13 dark-mode-synced framing pinned: 'Customers checking status during an incident shouldn't experience a brand-jarring light theme when the rest of the product is dark.' Drift to a different theme would create a brand-jarring mid-incident UX", () => {
    expect(body).toMatch(/R13 — status-site dark surface synced with marketing-site \+/);
    expect(body).toMatch(/customer-dashboard \+ docs/);
    expect(body).toMatch(
      /Customers checking status during an\s*\n?\s*incident shouldn't experience a brand-jarring light theme when\s*\n?\s*the rest of the product is dark\./,
    );
    expect(body).toMatch(/color-scheme: dark;/);
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
      /pre \{\s*\n?\s*\/\* F-1 — code blocks scroll internally rather than pushing page\. \*\/\s*\n?\s*overflow-x: auto;\s*\n?\s*\}|pre \{\s*\n?\s*overflow-x: auto;\s*\n?\s*\}/,
    );
  });
});
