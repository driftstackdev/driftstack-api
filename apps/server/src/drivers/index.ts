// Driver factory — selects the implementation based on config.

import type { Config } from '../lib/config.js';
import type { Driver } from './types.js';
import { MockDriver } from './mock.js';
import { WebKitDriver } from './webkit.js';

export type { Driver } from './types.js';
export * from './types.js';
export { MockDriver } from './mock.js';
export { WebKitDriver } from './webkit.js';

export async function createDriver(
  config: Pick<
    Config,
    | 'driver'
    | 'mockNavigateLatencyMs'
    | 'mockInteractLatencyMs'
    | 'playwrightBrowser'
    | 'playwrightHeaded'
  >,
): Promise<Driver> {
  if (config.driver === 'mock') {
    return new MockDriver({
      navigateLatencyMs: config.mockNavigateLatencyMs,
      interactLatencyMs: config.mockInteractLatencyMs,
    });
  }
  // V-333b — Playwright driver. Dev / E2E only; the production
  // driver is the WebKit fork (DRIVER=webkit), which lands when
  // Agent 1's WebKit Phase 2 closes. Loaded lazily so prod builds
  // don't pull in @playwright/test (a devDependency).
  if (config.driver === 'playwright') {
    const { PlaywrightDriver } = await import('./playwright.js');
    return new PlaywrightDriver({
      browserKind: config.playwrightBrowser,
      headed: config.playwrightHeaded,
    });
  }
  return new WebKitDriver();
}
