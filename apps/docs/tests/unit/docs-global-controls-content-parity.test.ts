import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HEADER = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/components/Header.astro'), 'utf8');
const FOOTER = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/components/Footer.astro'), 'utf8');
const LAYOUT = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/layouts/BaseLayout.astro'), 'utf8');
const BUILT_HOME = resolve(REPO_ROOT, 'apps/docs/dist/index.html');

describe('docs global control accessibility', () => {
  it('exposes all three theme controls with synchronized next-action labels', () => {
    const controls = `${HEADER}\n${FOOTER}`.match(/data-theme-toggle/g) ?? [];
    expect(controls).toHaveLength(3);
    expect(`${HEADER}\n${FOOTER}`.match(/aria-label="Switch to light theme"/g)).toHaveLength(3);
    expect(`${HEADER}\n${FOOTER}`.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(`${HEADER}\n${FOOTER}`.match(/title="Switch to light theme"/g)).toHaveLength(3);
    expect(LAYOUT).toMatch(/function syncThemeControls\(mode\)/);
    expect(LAYOUT).toMatch(/control\.setAttribute\('aria-pressed', light \? 'true' : 'false'\)/);
    expect(LAYOUT).toMatch(
      /var actionLabel = light \? 'Switch to dark theme' : 'Switch to light theme'/,
    );
    expect(LAYOUT).toMatch(/control\.setAttribute\('aria-label', actionLabel\)/);
    expect(LAYOUT).toMatch(/control\.setAttribute\('title', actionLabel\)/);
    expect(LAYOUT).toMatch(/syncThemeControls\(next\)/);
  });

  it('executes the built theme transition coherently across desktop, mobile, and footer', () => {
    const html = readFileSync(BUILT_HOME, 'utf8');
    const script = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
      .map((match) => match[1] ?? '')
      .find((candidate) => candidate.includes('function syncThemeControls(mode)'));
    expect(script).toBeDefined();

    const dom = new JSDOM(html, {
      url: 'https://docs.driftstack.dev/',
      runScripts: 'outside-only',
    });
    dom.window.eval(script!);
    const controls = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]'),
    );
    expect(controls).toHaveLength(3);
    expect(
      controls.every(
        (control) =>
          control.getAttribute('aria-label') === 'Switch to light theme' &&
          control.getAttribute('title') === 'Switch to light theme' &&
          control.getAttribute('aria-pressed') === 'false',
      ),
    ).toBe(true);

    controls[0]?.click();
    expect(dom.window.document.documentElement.getAttribute('data-mode')).toBe('light');
    expect(
      controls.every(
        (control) =>
          control.getAttribute('aria-label') === 'Switch to dark theme' &&
          control.getAttribute('title') === 'Switch to dark theme' &&
          control.getAttribute('aria-pressed') === 'true',
      ),
    ).toBe(true);
    dom.window.close();
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
