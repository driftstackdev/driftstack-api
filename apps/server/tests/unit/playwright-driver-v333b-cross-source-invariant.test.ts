// W987 — PlaywrightDriver V-333b cross-source invariant. Three-
// hundred-thirteenth in the drift-guard series. Pins the apps/
// server/src/drivers/playwright.ts dev/E2E driver primitive:
//
//   V-333b anchor — 'V-333b — Playwright-backed driver. Foundation
//   for self-hosted local dev + E2E testing on the Mac BEFORE the
//   WebKit fork (Agent 1) lands the production driver. Selecting via
//   DRIVER=playwright + PLAYWRIGHT_BROWSER=webkit|chromium|firefox'.
//
//   Trade-offs framing — 3 bullets:
//     - Playwright WebKit channel != Driftstack-modified WebKit (no
//       fingerprint-quality eval against prod targets).
//     - No iPhone-archetype mapping (just viewport + UA approx).
//     - Single-context-per-session + no profile persistence yet
//       (V-333c follow-on).
//
//   What-this-IS framing: founder Mac dev verification + CI E2E
//     tests of route + service layers.
//
//   What-this-IS-NOT framing: 'Production customer traffic. The
//   WebKit fork is the only production-eligible driver.
//   PlaywrightDriver is dev/test only'.
//
//   PlaywrightBrowserKind 3-value union: 'webkit' | 'chromium' |
//     'firefox'.
//
//   PlaywrightDriverConfig 2-field shape — browserKind +
//     optional headed (defaults false).
//
//   SessionEntry 3-field shape — context + page + createdAt.
//
//   Shared-Browser framing — 'Single shared Browser instance across
//   all sessions; per-session BrowserContext for state isolation.
//   Context is closed on destroy(). The Browser itself is launched
//   lazily on the first createSession + reused; never closed (process
//   exit reaps it)'.
//
//   getBrowser launcher branch — chromium / firefox / webkit (default).
//
//   Mobile context settings — viewport + userAgent + deviceScaleFactor
//     3 + isMobile true + hasTouch true.
//
//   Session-id format — 'pw_<8-hex>_<base36-unix-ms>'.
//
//   navigate waitUntil mapping — networkidle / load / else
//     domcontentloaded.
//
//   4 NotIntegrated stubs — interact + guiInput + wait + non-
//     screenshot capture throw DriverNotIntegratedError.
//
//   capture screenshot-only branch — page.screenshot({fullPage}) +
//     base64 encoding + byteLength.
//
//   destroy idempotent + best-effort context.close().catch.
//
//   requireSession throws BadRequestError on missing.
//
//   approximateViewport 4-branch ladder — 'iphone-16-pro' 402x874,
//     'iphone-15' 393x852, 'iphone-14' 390x844, default 402x874.
//
//   approximateUserAgent — ios-26 → WebKit 619 / Safari 26, else iOS
//     17.4 / Safari 17.4 UA.
//
// stays in lockstep across apps/server/src/drivers/playwright.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W987 PlaywrightDriver V-333b cross-source invariant', () => {
  // ─── V-333b anchor + selection framing ───────────────────────

  it("CRITICAL apps/server/src/drivers/playwright.ts header pins V-333b anchor — 'V-333b — Playwright-backed driver. Foundation for self-hosted local dev + E2E testing on the Mac BEFORE the WebKit fork (Agent 1) lands the production driver. Selecting via DRIVER=playwright + PLAYWRIGHT_BROWSER=webkit|chromium|firefox'. The V-333b dev-only + before-WebKit-fork + env-var-selection design is the V-333b deferred-Phase-2 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/V-333b — Playwright-backed driver\. Foundation for self-hosted local/);
    expect(p).toMatch(/dev \+ E2E testing on the Mac BEFORE the WebKit fork \(Agent 1\) lands/);
    expect(p).toMatch(/the production driver\. Selecting via DRIVER=playwright \+/);
    expect(p).toMatch(/PLAYWRIGHT_BROWSER=webkit\|chromium\|firefox\./);
  });

  // ─── Trade-offs 3-bullet framing ─────────────────────────────

  it("CRITICAL trade-offs framing — 'Trade-offs vs the eventual WebKitDriver (real fork):' with 3 bullets: Playwright WebKit channel != Driftstack-modified WebKit + no iPhone-archetype mapping + single-context-per-session no-profile-persistence-V-333c. The 3-bullet trade-off is the V-333b honest-limitations contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/Trade-offs vs the eventual WebKitDriver \(real fork\):/);
    expect(p).toMatch(/- Playwright's WebKit channel is the same WebKit upstream; it/);
    expect(p).toMatch(/does NOT include the Driftstack source modifications\./);
    expect(p).toMatch(/- No iPhone-archetype mapping \(no audio\/screen\/HW concurrency/);
    expect(p).toMatch(/overrides\)\./);
    expect(p).toMatch(/- Single-context-per-session keeps memory bounded; no profile/);
    expect(p).toMatch(/persistence yet \(V-333c follow-on\)\./);
  });

  // ─── What-IS vs What-IS-NOT ──────────────────────────────────

  it("CRITICAL what-is-NOT framing — 'Production customer traffic. The WebKit fork is the only production-eligible driver. PlaywrightDriver is dev/test only'. The prod-WebKit-only design forbids using Playwright in prod.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/What this DRIVER is NOT for:/);
    expect(p).toMatch(/- Production customer traffic\. The WebKit fork is the only/);
    expect(p).toMatch(/production-eligible driver\. PlaywrightDriver is dev\/test only\./);
  });

  // ─── PlaywrightBrowserKind 3-value union ─────────────────────

  it("CRITICAL PlaywrightBrowserKind = 'webkit' | 'chromium' | 'firefox'. The 3-value union matches the 3 @playwright/test launcher names.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/export type PlaywrightBrowserKind = 'webkit' \| 'chromium' \| 'firefox';/);
  });

  // ─── PlaywrightDriverConfig 2-field shape ────────────────────

  it('CRITICAL PlaywrightDriverConfig has browserKind + optional headed. The 2-field shape is what bootstrap.ts wires from playwrightBrowser + playwrightHeaded env vars.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/export interface PlaywrightDriverConfig \{/);
    expect(p).toMatch(/browserKind: PlaywrightBrowserKind;/);
    expect(p).toMatch(/headed\?: boolean;/);
  });

  // ─── SessionEntry 3-field shape ──────────────────────────────

  it('CRITICAL SessionEntry 3-field shape — context + page + createdAt. The 3-field shape pairs the BrowserContext + Page for per-session state isolation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/interface SessionEntry \{/);
    expect(p).toMatch(/context: BrowserContext;/);
    expect(p).toMatch(/page: Page;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  // ─── Shared-Browser framing ──────────────────────────────────

  it("CRITICAL shared-Browser framing — 'V-333b — Playwright driver. Single shared Browser instance across all sessions; per-session BrowserContext for state isolation. Context is closed on destroy(). The Browser itself is launched lazily on the first createSession + reused; never closed (process exit reaps it)'. The shared-Browser + per-context-isolation + lazy-launch design is the V-333b resource model.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/V-333b — Playwright driver\./);
    expect(p).toMatch(/Single shared `Browser` instance across all sessions; per-session/);
    expect(p).toMatch(/`BrowserContext` for state isolation\. Context is closed on/);
    expect(p).toMatch(/`destroy\(\)`\. The Browser itself is launched lazily on the first/);
    expect(p).toMatch(/createSession \+ reused; never closed \(process exit reaps it\)\./);
  });

  // ─── getBrowser launcher branch ──────────────────────────────

  it('CRITICAL getBrowser launcher 3-branch ladder — chromium / firefox / webkit (default). The nested ternary maps browserKind to the @playwright/test launcher.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/this\.config\.browserKind === 'chromium'/);
    expect(p).toMatch(/\? chromium/);
    expect(p).toMatch(/this\.config\.browserKind === 'firefox'/);
    expect(p).toMatch(/\? firefox/);
    expect(p).toMatch(/: webkit;/);
  });

  it("CRITICAL launch headless inverted from config.headed — 'launcher.launch({ headless: this.config.headed !== true })'. The !==true inversion lets undefined-headed default to headless.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(
      /this\.browserPromise = launcher\.launch\(\{ headless: this\.config\.headed !== true \}\);/,
    );
  });

  // ─── Mobile context settings ─────────────────────────────────

  it('CRITICAL browser.newContext 5-field mobile-context — viewport + userAgent + deviceScaleFactor 3 + isMobile true + hasTouch true. The 3x scale + isMobile + hasTouch make Playwright emulate iPhone-style touch input.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/const context = await browser\.newContext\(\{/);
    expect(p).toMatch(/viewport,/);
    expect(p).toMatch(/userAgent,/);
    expect(p).toMatch(/deviceScaleFactor: 3,/);
    expect(p).toMatch(/isMobile: true,/);
    expect(p).toMatch(/hasTouch: true,/);
  });

  // ─── Session-id format ───────────────────────────────────────

  it("CRITICAL session-id format — 'pw_<8-hex>_<base36-unix-ms>'. The pw_-prefix distinguishes from mock_ses_ ids; hex + base36 are compact + URL-safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/Format: pw_<random-hex>_<unix-ms-base36>\./);
    expect(p).toMatch(/const sessionId = `pw_\$\{Math\.floor\(Math\.random\(\) \* 0xffffffff\)/);
    expect(p).toMatch(/\.toString\(16\)/);
    expect(p).toMatch(/\.padStart\(8, '0'\)\}_\$\{Date\.now\(\)\.toString\(36\)\}`;/);
  });

  // ─── navigate waitUntil mapping ──────────────────────────────

  it("CRITICAL navigate waitUntil 3-branch ladder — 'networkidle' / 'load' / else 'domcontentloaded'. The mapping translates Driftstack's 3-value enum to Playwright's loadState.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/input\.waitUntil === 'networkidle'/);
    expect(p).toMatch(/\? 'networkidle'/);
    expect(p).toMatch(/input\.waitUntil === 'load'/);
    expect(p).toMatch(/\? 'load'/);
    expect(p).toMatch(/: 'domcontentloaded',/);
  });

  // ─── 4 NotIntegrated stubs ───────────────────────────────────

  it("CRITICAL 4 NotIntegrated stubs framing — 'V-333b — interact / wait / capture / getState have minimal Playwright mappings sufficient for E2E smoke testing. The full semantic surface (recipe library, behavioral simulation, recapture-automation) is NOT modeled here; that's the production WebKitDriver's job. PlaywrightDriver returns a NotIntegrated shape for surfaces that haven't been minimally wired so the gap is loud + visible'. The loud-gap design helps spot missing wiring early.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/V-333b — interact \/ wait \/ capture \/ getState have minimal/);
    expect(p).toMatch(/Playwright mappings sufficient for E2E smoke testing\. The full/);
    expect(p).toMatch(/semantic surface \(recipe library, behavioral simulation,/);
    expect(p).toMatch(/recapture-automation\) is NOT modeled here; that's the production/);
    expect(p).toMatch(/WebKitDriver's job\. PlaywrightDriver returns a NotIntegrated/);
    expect(p).toMatch(/shape for surfaces that haven't been minimally wired so the gap/);
    expect(p).toMatch(/is loud \+ visible\./);
  });

  it('CRITICAL interact + guiInput + wait + non-screenshot capture all throw DriverNotIntegratedError. The 4 stubs surface the gap loudly + visibly.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    const matches = p.match(/throw new DriverNotIntegratedError\(\);/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  // ─── capture screenshot-only ─────────────────────────────────

  it('CRITICAL capture screenshot-only branch — page.screenshot({fullPage:input.fullPage}) + base64 encoding + byteLength. Non-screenshot kinds throw NotIntegrated.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/if \(input\.kind === 'screenshot'\) \{/);
    expect(p).toMatch(
      /const buf = await entry\.page\.screenshot\(\{ fullPage: input\.fullPage \}\);/,
    );
    expect(p).toMatch(/data: buf\.toString\('base64'\),/);
    expect(p).toMatch(/encoding: 'base64',/);
    expect(p).toMatch(/byteSize: buf\.byteLength,/);
    expect(p).toMatch(/\/\/ 'state' \/ 'pdf' fall through; not yet wired\./);
  });

  // ─── destroy idempotent ──────────────────────────────────────

  it('CRITICAL destroy idempotent — if (!entry) return + best-effort context.close().catch swallow. The early-return + swallow lets cleanup paths run safely on missing or already-closed contexts.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/async destroy\(sessionId: DriverSessionId\): Promise<void> \{/);
    expect(p).toMatch(/const entry = this\.sessions\.get\(sessionId\);/);
    expect(p).toMatch(/if \(!entry\) return;/);
    expect(p).toMatch(/this\.sessions\.delete\(sessionId\);/);
    expect(p).toMatch(/await entry\.context\.close\(\)\.catch\(\(\) => \{/);
    expect(p).toMatch(/\/\* swallow — best-effort \*\//);
  });

  // ─── requireSession BadRequestError ──────────────────────────

  it('CRITICAL requireSession throws BadRequestError on missing — \'Driver session "<id>" not found.\'. The BadRequest design surfaces the not-found as a 400 (client passed an invalid session ref).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/private requireSession\(sessionId: DriverSessionId\): SessionEntry \{/);
    expect(p).toMatch(
      /throw new BadRequestError\(`Driver session "\$\{sessionId\}" not found\.`\);/,
    );
  });

  // ─── approximateViewport 4-branch ladder ─────────────────────

  it('CRITICAL approximateViewport ladder — iphone-16-pro 402x874 + iphone-15 393x852 + iphone-14 390x844 + default 402x874. The 4-branch ladder covers the 3 newest iPhone models + a default fallback.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(
      /if \(archetype\.includes\('iphone-16-pro'\)\) return \{ width: 402, height: 874 \};/,
    );
    expect(p).toMatch(
      /if \(archetype\.includes\('iphone-15'\)\) return \{ width: 393, height: 852 \};/,
    );
    expect(p).toMatch(
      /if \(archetype\.includes\('iphone-14'\)\) return \{ width: 390, height: 844 \};/,
    );
    expect(p).toMatch(/return \{ width: 402, height: 874 \};/);
  });

  // ─── approximateUserAgent ────────────────────────────────────

  it("CRITICAL approximateUserAgent ios-26 branch — 'AppleWebKit/619.1.26 ... Version/26.0 ... Safari/619.1'. The 26.0 + 619 family matches iOS 26.4.1 / Safari 26 default-archetype.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/if \(archetype\.includes\('ios-26'\)\) \{/);
    expect(p).toMatch(/AppleWebKit\/619\.1\.26.*Version\/26\.0.*Safari\/619\.1/);
  });

  it('CRITICAL approximateUserAgent default fallback — iOS 17.4 + Safari 17.4 (AppleWebKit/605.1.15 ... Version/17.4 ... Safari/604.1). The conservative default covers older customer archetypes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts'));
    expect(p).toMatch(/AppleWebKit\/605\.1\.15.*Version\/17\.4.*Safari\/604\.1/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/playwright-driver-v333b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
