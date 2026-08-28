// Public-truth guard: the device-code authorization protocol is live for the
// desktop product, but there is no published Driftstack CLI distributable.
// Keep the fictional install/command/keyring page absent without deleting the
// real dashboard binder or its server-side protocol.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CLI_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cli-quickstart.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts');
const DASHBOARD_BINDER = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/cli/authorize.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const publicPages = [
  ...walk(resolve(REPO_ROOT, 'apps/marketing-site/src/pages')),
  ...walk(resolve(REPO_ROOT, 'apps/docs/src/pages')),
].filter((path) => /\.(?:astro|md)$/.test(path));

describe('public CLI absence and desktop authorization protocol truth', () => {
  it('does not publish the nonexistent CLI quickstart or link to it', () => {
    expect(existsSync(CLI_PAGE)).toBe(false);

    const links = publicPages.filter((path) => read(path).includes('/docs/cli-quickstart'));
    expect(links).toEqual([]);
  });

  it('does not advertise fictional CLI packages, installers, releases, commands, or keyring storage', () => {
    const forbidden = [
      /@driftstack\/cli\b/,
      /brew install driftstack\/tap\/driftstack/,
      /driftstack\/2\.3\.x/,
      /\bdriftstack (?:login|logout|sessions|profiles|api-keys|config|--version|--profile)\b/,
      /\bdriftstack-cli\b/,
    ];

    for (const pattern of forbidden) {
      const offenders = publicPages
        .filter((path) => pattern.test(read(path)))
        .map((path) => path.slice(REPO_ROOT.length + 1));
      expect(offenders, `public pages matching ${String(pattern)}`).toEqual([]);
    }
  });

  it('has no workspace package or executable named @driftstack/cli or driftstack', () => {
    const manifests = [
      resolve(REPO_ROOT, 'package.json'),
      ...walk(resolve(REPO_ROOT, 'apps')).filter((path) => path.endsWith('/package.json')),
      ...walk(resolve(REPO_ROOT, 'packages')).filter((path) => path.endsWith('/package.json')),
    ];
    const offenders: string[] = [];

    for (const manifest of manifests) {
      const parsed = JSON.parse(read(manifest)) as {
        name?: string;
        bin?: string | Record<string, string>;
      };
      const hasDriftstackBin =
        typeof parsed.bin === 'object' &&
        parsed.bin !== null &&
        Object.prototype.hasOwnProperty.call(parsed.bin, 'driftstack');
      if (parsed.name === '@driftstack/cli' || parsed.name === 'driftstack' || hasDriftstackBin) {
        offenders.push(manifest.slice(REPO_ROOT.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('preserves the live desktop browser-authorization protocol and binder', () => {
    const route = read(ROUTE);
    const service = read(SERVICE);
    const dashboard = read(DASHBOARD_BINDER);

    for (const path of [
      '/v1/auth/cli-authorize/initiate',
      '/v1/auth/cli-authorize/exchange',
      '/v1/auth/cli-authorize/bind-device-code',
    ]) {
      expect(route).toContain(`'${path}'`);
    }
    expect(service).toMatch(/TTL_SECONDS\s*=\s*5\s*\*\s*60/);
    expect(dashboard).toContain('/v1/auth/cli-authorize/bind-device-code');
  });
});
