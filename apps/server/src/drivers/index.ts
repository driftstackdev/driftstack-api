// Driver factory — selects the implementation based on config.

import type { Config } from '../lib/config.js';
import type { Driver } from './types.js';
import { MockDriver } from './mock.js';
import { WebKitDriver } from './webkit.js';

export type { Driver } from './types.js';
export * from './types.js';
export { MockDriver } from './mock.js';
export { WebKitDriver } from './webkit.js';

export function createDriver(
  config: Pick<Config, 'driver' | 'mockNavigateLatencyMs' | 'mockInteractLatencyMs'>,
): Driver {
  if (config.driver === 'mock') {
    return new MockDriver({
      navigateLatencyMs: config.mockNavigateLatencyMs,
      interactLatencyMs: config.mockInteractLatencyMs,
    });
  }
  return new WebKitDriver();
}
