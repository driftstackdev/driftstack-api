import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const ASTRO_APPS = [
  'admin-panel',
  'customer-dashboard',
  'marketing-site',
  'docs',
  'status-site',
] as const;
const TAILWIND_3_APPS = ['admin-panel', 'customer-dashboard', 'marketing-site'] as const;
const TAILWIND_4_APPS = ['docs', 'status-site'] as const;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function packageJson(app: (typeof ASTRO_APPS)[number]): {
  dependencies: Record<string, string>;
} {
  return JSON.parse(read(`apps/${app}/package.json`)) as {
    dependencies: Record<string, string>;
  };
}

describe('Astro Pages toolchain parity', () => {
  it('all five Pages apps use the patched Astro 7 line and preserve legacy whitespace', () => {
    for (const app of ASTRO_APPS) {
      expect(packageJson(app).dependencies.astro, app).toBe('7.0.7');
      expect(read(`apps/${app}/astro.config.mjs`), app).toMatch(/compressHTML:\s*true/);
    }
  });

  it('static Pages apps have no Cloudflare SSR adapter dependency or config', () => {
    for (const app of ['admin-panel', 'customer-dashboard'] as const) {
      expect(packageJson(app).dependencies, app).not.toHaveProperty('@astrojs/cloudflare');
      expect(read(`apps/${app}/astro.config.mjs`), app).not.toMatch(
        /@astrojs\/cloudflare|adapter:\s*cloudflare/,
      );
    }
    expect(packageJson('customer-dashboard').dependencies).not.toHaveProperty('@sentry/cloudflare');
  });

  it('Tailwind 3 apps use explicit PostCSS and retain their explicit base layer', () => {
    for (const app of TAILWIND_3_APPS) {
      const dependencies = packageJson(app).dependencies;
      expect(dependencies, app).not.toHaveProperty('@astrojs/tailwind');
      expect(dependencies.postcss, app).toBe('8.5.19');
      expect(dependencies.autoprefixer, app).toBe('10.5.2');
      expect(read(`apps/${app}/postcss.config.mjs`), app).toMatch(/tailwindcss:\s*\{\}/);
      expect(read(`apps/${app}/tailwind.config.mjs`), app).not.toMatch(
        /corePlugins:\s*\{\s*preflight:\s*false/,
      );
    }
  });

  it('Tailwind 4 apps use the Vite plugin without a legacy PostCSS bridge', () => {
    for (const app of TAILWIND_4_APPS) {
      const dependencies = packageJson(app).dependencies;
      expect(dependencies['@tailwindcss/vite'], app).toBe('4.3.2');
      expect(read(`apps/${app}/astro.config.mjs`), app).toMatch(
        /import tailwindcss from '@tailwindcss\/vite'/,
      );
      expect(read(`apps/${app}/astro.config.mjs`), app).toMatch(
        /vite:\s*\{\s*plugins:\s*\[tailwindcss\(\)\]/,
      );
      expect(existsSync(resolve(REPO_ROOT, `apps/${app}/postcss.config.mjs`)), app).toBe(false);
    }
  });

  it('admin arbitrary-id routes proxy to real static shell files without matching list routes', () => {
    const redirects = read('apps/admin-panel/public/_redirects');
    expect(redirects).toMatch(/^\/accounts\/:id \/shells\/account-detail\/ 200$/m);
    expect(redirects).toMatch(/^\/incidents\/:id \/shells\/incident-detail\/ 200$/m);
    expect(redirects).not.toMatch(/^\/accounts\/:id \/shells\/account-detail 200$/m);
    expect(redirects).not.toMatch(/^\/incidents\/:id \/shells\/incident-detail 200$/m);
    expect(redirects).not.toMatch(/^\/accounts\/\*/m);
    expect(redirects).not.toMatch(/^\/incidents\/\*/m);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro')),
    ).toBe(true);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/incident-detail.astro')),
    ).toBe(true);
  });
});
