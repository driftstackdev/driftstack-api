import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HEADER = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/components/Header.astro'), 'utf8');
const FOOTER = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/components/Footer.astro'), 'utf8');
const LAYOUT = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/layouts/BaseLayout.astro'), 'utf8');

describe('docs global control accessibility', () => {
  it('exposes all three theme controls as synchronized Light theme toggles', () => {
    const controls = `${HEADER}\n${FOOTER}`.match(/data-theme-toggle/g) ?? [];
    expect(controls).toHaveLength(3);
    expect(`${HEADER}\n${FOOTER}`.match(/aria-label="Light theme"/g)).toHaveLength(3);
    expect(`${HEADER}\n${FOOTER}`.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(`${HEADER}\n${FOOTER}`.match(/title="Switch to light theme"/g)).toHaveLength(3);
    expect(LAYOUT).toMatch(/function syncThemeControls\(mode\)/);
    expect(LAYOUT).toMatch(/control\.setAttribute\('aria-pressed', light \? 'true' : 'false'\)/);
    expect(LAYOUT).toMatch(/light \? 'Switch to dark theme' : 'Switch to light theme'/);
    expect(LAYOUT).toMatch(/syncThemeControls\(next\)/);
  });

  it('keeps the Header native menu stateful and dismissible without changing DocLayout', () => {
    expect(HEADER).toMatch(/<details class="relative" data-mobile-nav>/);
    expect(HEADER).toMatch(/aria-label="Open navigation menu"/);
    expect(HEADER).toMatch(/aria-expanded="false"/);
    expect(LAYOUT).toContain("document.querySelector('[data-mobile-nav]')");
    expect(LAYOUT).toMatch(/menu\.addEventListener\('toggle', syncMobileMenu\)/);
    expect(LAYOUT).toMatch(/expanded \? 'Close navigation menu' : 'Open navigation menu'/);
    expect(LAYOUT).toMatch(/event\.key !== 'Escape' \|\| !menu\.open/);
    expect(LAYOUT).toMatch(/!menu\.contains\(event\.target\)/);
    expect(LAYOUT).toMatch(/trigger\.focus\(\)/);
  });
});
