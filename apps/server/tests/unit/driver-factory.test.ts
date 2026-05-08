import { describe, expect, it } from 'vitest';
import {
  createDriver,
  MockDriver,
  PlaywrightDriver,
  WebKitDriver,
} from '../../src/drivers/index.js';
import { DriverNotIntegratedError } from '../../src/lib/errors.js';

const baseConfig = {
  mockNavigateLatencyMs: 0,
  mockInteractLatencyMs: 0,
  playwrightBrowser: 'webkit' as const,
  playwrightHeaded: false,
};

describe('createDriver factory', () => {
  it('returns a MockDriver when driver=mock', () => {
    const d = createDriver({ ...baseConfig, driver: 'mock' });
    expect(d).toBeInstanceOf(MockDriver);
  });

  it('returns a WebKitDriver stub when driver=webkit', () => {
    const d = createDriver({ ...baseConfig, driver: 'webkit' });
    expect(d).toBeInstanceOf(WebKitDriver);
  });

  it('returns a PlaywrightDriver when driver=playwright', () => {
    const d = createDriver({ ...baseConfig, driver: 'playwright' });
    expect(d).toBeInstanceOf(PlaywrightDriver);
  });
});

describe('WebKitDriver stub', () => {
  it('every method throws DriverNotIntegratedError', async () => {
    const d = new WebKitDriver();
    await expect(
      d.createSession({ archetype: 'x', purpose: 'production_customer' }),
    ).rejects.toBeInstanceOf(DriverNotIntegratedError);
    await expect(
      d.navigate('id', { url: 'https://example.com', timeoutMs: 1, waitUntil: 'load' }),
    ).rejects.toBeInstanceOf(DriverNotIntegratedError);
    await expect(
      d.interact('id', { action: { kind: 'press', key: 'x' }, timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(DriverNotIntegratedError);
    await expect(
      d.wait('id', { condition: { kind: 'time', ms: 1 }, timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(DriverNotIntegratedError);
    await expect(d.getState('id')).rejects.toBeInstanceOf(DriverNotIntegratedError);
    await expect(d.capture('id', { kind: 'screenshot', fullPage: false })).rejects.toBeInstanceOf(
      DriverNotIntegratedError,
    );
    await expect(d.destroy('id')).rejects.toBeInstanceOf(DriverNotIntegratedError);
  });
});
