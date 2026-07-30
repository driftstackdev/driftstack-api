// W985 — drivers factory + WebKit stub cross-source invariant.
// Three-hundred-eleventh in the drift-guard series. Pins the apps/
// server/src/drivers/{index.ts,webkit.ts} factory + stub primitives:
//
//   index.ts header — 'Driver factory — selects the implementation
//     based on config'.
//
//   3-branch factory:
//     - 'mock' → MockDriver(navigateLatencyMs, interactLatencyMs).
//     - 'playwright' → V-333b lazy import + PlaywrightDriver(
//       browserKind, headed).
//     - else → WebKitDriver().
//
//   V-333b lazy-import framing — 'V-333b — Playwright driver. Dev /
//   E2E only; the production driver is the WebKit fork
//   (DRIVER=webkit), which lands when Agent 1's WebKit Phase 2
//   closes. Loaded lazily so prod builds don't pull in @playwright/
//   test (a devDependency)'.
//
//   createDriver config Pick — 5 fields: driver + mockNavigateLatencyMs
//     + mockInteractLatencyMs + playwrightBrowser + playwrightHeaded.
//
//   Re-exports — Driver type + types.ts wildcard + MockDriver +
//     WebKitDriver named exports.
//
//   webkit.ts header — 'Real WebKit driver — NOT YET INTEGRATED.
//   This stub is what the driver factory returns when DRIVER=webkit
//   is set. Every method throws DriverNotIntegratedError. The class
//   exists so that the route layer can construct + use a Driver
//   implementation; when the Driftstack WebKit fork closes its
//   Phase 2, this file is replaced with the real adapter (and the
//   WebKit fork hands off the binding details)'.
//
//   WebKitDriver implements Driver — all 8 methods throw
//   DriverNotIntegratedError after a no-op await Promise.resolve()
//   (ESLint require-await compliance pattern).
//
//   Runtime: createDriver({driver:'mock'}) returns MockDriver;
//   createDriver({driver:'webkit'}) returns WebKitDriver; WebKit's
//   createSession throws DriverNotIntegratedError at call-time.
//
// stays in lockstep across apps/server/src/drivers/index.ts +
// apps/server/src/drivers/webkit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockDriver, WebKitDriver, createDriver } from '../../src/drivers/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W985 drivers factory + WebKit cross-source invariant', () => {
  // ─── index.ts factory header ─────────────────────────────────

  it("CRITICAL apps/server/src/drivers/index.ts header pins surface — 'Driver factory — selects the implementation based on config'. The config-driven 3-branch factory is the V-156 driver-selection contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/Driver factory — selects the implementation based on config\./);
  });

  // ─── 3-branch factory + V-333b lazy ──────────────────────────

  it("CRITICAL mock branch — 'if (config.driver === mock)' returns 'new MockDriver({navigateLatencyMs, interactLatencyMs})'. The 2-field MockDriver constructor matches the mock-driver-options shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/if \(config\.driver === 'mock'\) \{/);
    expect(p).toMatch(/return new MockDriver\(\{/);
    expect(p).toMatch(/navigateLatencyMs: config\.mockNavigateLatencyMs,/);
    expect(p).toMatch(/interactLatencyMs: config\.mockInteractLatencyMs,/);
  });

  it("CRITICAL V-333b lazy-import framing — 'V-333b — Playwright driver. Dev / E2E only; the production driver is the WebKit fork (DRIVER=webkit), which lands when Agent 1's WebKit Phase 2 closes. Loaded lazily so prod builds don't pull in @playwright/test (a devDependency)'. The dev-only + lazy-import + no-prod-bundle design is the V-333b prod-cleanliness contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/V-333b — Playwright driver\. Dev \/ E2E only; the production/);
    expect(p).toMatch(/driver is the WebKit fork \(DRIVER=webkit\), which lands when/);
    expect(p).toMatch(/Agent 1's WebKit Phase 2 closes\. Loaded lazily so prod builds/);
    expect(p).toMatch(/don't pull in @playwright\/test \(a devDependency\)\./);
  });

  it("CRITICAL playwright branch — dynamic import of './playwright.js' + 'new PlaywrightDriver({browserKind, headed})'. The dynamic-import is what keeps the @playwright/test require out of the prod tree.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/if \(config\.driver === 'playwright'\) \{/);
    expect(p).toMatch(/const \{ PlaywrightDriver \} = await import\('\.\/playwright\.js'\);/);
    expect(p).toMatch(/return new PlaywrightDriver\(\{/);
    expect(p).toMatch(/browserKind: config\.playwrightBrowser,/);
    expect(p).toMatch(/headed: config\.playwrightHeaded,/);
  });

  it('CRITICAL webkit branch is the fallthrough — returns new WebKitDriver(). The else-fallthrough means DRIVER=webkit is the unset-default behavior.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/return new WebKitDriver\(\);/);
  });

  // ─── createDriver Pick<Config, ...> ──────────────────────────

  it('CRITICAL createDriver config Pick picks 5 fields — driver + mockNavigateLatencyMs + mockInteractLatencyMs + playwrightBrowser + playwrightHeaded. The 5-field Pick lets bootstrap.ts pass a minimal config slice.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/export async function createDriver\(/);
    expect(p).toMatch(/config: Pick</);
    expect(p).toMatch(/Config,/);
    expect(p).toMatch(/\| 'driver'/);
    expect(p).toMatch(/\| 'mockNavigateLatencyMs'/);
    expect(p).toMatch(/\| 'mockInteractLatencyMs'/);
    expect(p).toMatch(/\| 'playwrightBrowser'/);
    expect(p).toMatch(/\| 'playwrightHeaded'/);
  });

  // ─── Re-exports ──────────────────────────────────────────────

  it("CRITICAL re-exports — 'export type { Driver } from ./types.js' + 'export * from ./types.js' + named MockDriver + WebKitDriver. The 4-export surface is what services/routes consume.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/index.ts'));
    expect(p).toMatch(/export type \{ Driver \} from '\.\/types\.js';/);
    expect(p).toMatch(/export \* from '\.\/types\.js';/);
    expect(p).toMatch(/export \{ MockDriver \} from '\.\/mock\.js';/);
    expect(p).toMatch(/export \{ WebKitDriver \} from '\.\/webkit\.js';/);
  });

  // ─── webkit.ts header ────────────────────────────────────────

  it("CRITICAL apps/server/src/drivers/webkit.ts header pins surface — 'Real WebKit driver — NOT YET INTEGRATED. This stub is what the driver factory returns when DRIVER=webkit is set. Every method throws DriverNotIntegratedError. The class exists so that the route layer can construct + use a Driver implementation; when the Driftstack WebKit fork closes its Phase 2, this file is replaced with the real adapter (and the WebKit fork hands off the binding details)'. The stub-for-shape + replace-on-Phase-2 design is the V-156 forward-compat contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/webkit.ts'));
    expect(p).toMatch(/Real WebKit driver — NOT YET INTEGRATED\./);
    expect(p).toMatch(/This stub is what the driver factory returns when DRIVER=webkit is set\./);
    expect(p).toMatch(
      /Every method throws DriverNotIntegratedError\. The class exists so that the/,
    );
    expect(p).toMatch(/route layer can construct \+ use a Driver implementation; when the/);
    expect(p).toMatch(/Driftstack WebKit fork closes its Phase 2, this file is replaced with the/);
    expect(p).toMatch(/real adapter \(and the WebKit fork hands off the binding details\)\./);
  });

  // ─── WebKitDriver 8 throw methods ────────────────────────────

  it("CRITICAL WebKitDriver implements Driver + all 11 methods throw DriverNotIntegratedError after no-op await Promise.resolve(). The require-await + throw pattern keeps ESLint happy + signals 'every method is stubbed'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/webkit.ts'));
    expect(p).toMatch(/export class WebKitDriver implements Driver \{/);
    expect(p).toContain("readonly searchCapability = 'unavailable' as const;");
    expect(p).toContain("readonly loginCapability = 'unavailable' as const;");
    // Count throw DriverNotIntegratedError occurrences.
    const matches = p.match(/throw new DriverNotIntegratedError\(\);/g) ?? [];
    expect(matches.length).toBe(11);
    // Verify all 11 method names.
    expect(p).toMatch(/async createSession\(/);
    expect(p).toMatch(/async navigate\(/);
    expect(p).toMatch(/async interact\(/);
    expect(p).toMatch(/async guiInput\(/);
    expect(p).toMatch(/async wait\(/);
    expect(p).toMatch(/async getState\(/);
    expect(p).toMatch(/async capture\(/);
    expect(p).toMatch(/async extract\(/);
    expect(p).toMatch(/async search\(/);
    expect(p).toMatch(/async login\(/);
    expect(p).toMatch(/async destroy\(/);
  });

  // ─── Runtime — createDriver branches ─────────────────────────

  it('CRITICAL runtime — createDriver({driver:"mock", ...}) returns MockDriver instance.', async () => {
    const d = await createDriver({
      driver: 'mock',
      mockNavigateLatencyMs: 0,
      mockInteractLatencyMs: 0,
      playwrightBrowser: 'webkit',
      playwrightHeaded: false,
    });
    expect(d).toBeInstanceOf(MockDriver);
    expect(d.searchCapability).toBe('simulation');
    expect(d.loginCapability).toBe('simulation');
  });

  it('CRITICAL runtime — createDriver({driver:"webkit", ...}) returns WebKitDriver instance.', async () => {
    const d = await createDriver({
      driver: 'webkit',
      mockNavigateLatencyMs: 0,
      mockInteractLatencyMs: 0,
      playwrightBrowser: 'webkit',
      playwrightHeaded: false,
    });
    expect(d).toBeInstanceOf(WebKitDriver);
    expect(d.searchCapability).toBe('unavailable');
    expect(d.loginCapability).toBe('unavailable');
  });

  it('CRITICAL runtime — WebKitDriver.createSession throws DriverNotIntegratedError at call-time. The 8 throws keep the WebKitDriver-route-construction safe but every operation surfaces the integration gap.', async () => {
    const d = new WebKitDriver();
    await expect(
      d.createSession({
        archetype: 'iphone16pro_ios18_7_safari26_4',
        purpose: 'production_customer',
      }),
    ).rejects.toThrow();
  });

  it('CRITICAL runtime — all 8 WebKitDriver methods reject with DriverNotIntegratedError. Spot-check 4 methods (navigate, interact, guiInput, destroy).', async () => {
    const d = new WebKitDriver();
    await expect(
      d.navigate('sess_x', { url: 'https://example.com', timeoutMs: 1000, waitUntil: 'load' }),
    ).rejects.toThrow();
    await expect(
      d.interact('sess_x', {
        action: { kind: 'tap', selector: 'a' },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    await expect(
      d.guiInput('sess_x', {
        action: { kind: 'tap_at', x: 0, y: 0 },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    await expect(d.destroy('sess_x')).rejects.toThrow();
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/drivers-factory-webkit-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
