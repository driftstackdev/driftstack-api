// W431.A — drift guard for apps/server/src/drivers/index.ts.
// Driver factory + barrel. Drift here either breaks the
// DRIVER=playwright lazy-import (production builds pull in
// @playwright/test devDependency) or accidentally widens the
// default branch (DRIVER not in {mock,playwright} silently returns
// MockDriver instead of WebKitDriver-throws-DriverNotIntegrated).
//
//   • Framing pinned: factory selects implementation by config.
//   • Re-exports: Driver type + types.js barrel + MockDriver +
//     WebKitDriver.
//   • createDriver: config Pick<...> 5 keys; mock branch passes
//     latency opts; playwright V-333b lazy import (prod doesn't
//     pull @playwright/test); default branch returns
//     new WebKitDriver() (throws on every call until Phase 2).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W431.A apps/server/src/drivers/index.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: Driver factory — selects the implementation based on config', () => {
    expect(body).toMatch(/\/\/ Driver factory — selects the implementation based on config\./);
  });

  it('imports + re-exports: Config + Driver type; MockDriver + WebKitDriver classes; types.js barrel re-export', () => {
    expect(body).toMatch(/import type \{ Config \} from '\.\.\/lib\/config\.js';/);
    expect(body).toMatch(/import type \{ Driver \} from '\.\/types\.js';/);
    expect(body).toMatch(/import \{ MockDriver \} from '\.\/mock\.js';/);
    expect(body).toMatch(/import \{ WebKitDriver \} from '\.\/webkit\.js';/);
    expect(body).toMatch(/export type \{ Driver \} from '\.\/types\.js';/);
    expect(body).toMatch(/export \* from '\.\/types\.js';/);
    expect(body).toMatch(/export \{ MockDriver \} from '\.\/mock\.js';/);
    expect(body).toMatch(/export \{ WebKitDriver \} from '\.\/webkit\.js';/);
  });

  it('createDriver signature: Pick<Config, driver|mockNavigateLatencyMs|mockInteractLatencyMs|playwrightBrowser|playwrightHeaded>; returns Promise<Driver>', () => {
    expect(body).toMatch(
      /export async function createDriver\(\s*config: Pick<\s*Config,\s*\| 'driver'\s*\| 'mockNavigateLatencyMs'\s*\| 'mockInteractLatencyMs'\s*\| 'playwrightBrowser'\s*\| 'playwrightHeaded'\s*>,\s*\): Promise<Driver> \{/,
    );
  });

  it('Mock branch: if config.driver === "mock" returns new MockDriver with navigateLatencyMs + interactLatencyMs from config', () => {
    expect(body).toMatch(
      /if \(config\.driver === 'mock'\) \{\s*return new MockDriver\(\{\s*navigateLatencyMs: config\.mockNavigateLatencyMs,\s*interactLatencyMs: config\.mockInteractLatencyMs,\s*\}\);\s*\}/,
    );
  });

  it('V-333b Playwright branch: lazy import via await import("./playwright.js") so prod builds skip @playwright/test devDependency; browserKind + headed passed', () => {
    expect(body).toMatch(
      /\/\/ V-333b — Playwright driver\. Dev \/ E2E only; the production\s*\/\/ driver is the WebKit fork \(DRIVER=webkit\), which lands when\s*\/\/ Agent 1's WebKit Phase 2 closes\. Loaded lazily so prod builds\s*\/\/ don't pull in @playwright\/test \(a devDependency\)\./,
    );
    expect(body).toMatch(
      /if \(config\.driver === 'playwright'\) \{\s*const \{ PlaywrightDriver \} = await import\('\.\/playwright\.js'\);\s*return new PlaywrightDriver\(\{\s*browserKind: config\.playwrightBrowser,\s*headed: config\.playwrightHeaded,\s*\}\);\s*\}/,
    );
  });

  it('Default branch: returns new WebKitDriver() (throws DriverNotIntegratedError on every call until Phase 2)', () => {
    expect(body).toMatch(/return new WebKitDriver\(\);\s*\n?\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
