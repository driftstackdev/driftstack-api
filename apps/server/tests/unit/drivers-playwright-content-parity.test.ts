// W454.C — drift guard for apps/server/src/drivers/playwright.ts.
// V-333b PlaywrightDriver — dev/test-only browser driver. Drift here
// either drops the headed-flag inversion (headless: this.config.headed
// !== true; dropping the negation makes 'headed:true' run headless,
// breaking founder local-dev debugging) or weakens the dev/test-only
// posture warning (PRODUCTION rejection note disappears and we
// accidentally ship PlaywrightDriver to customer traffic).
//
//   • V-333b framing pinned + WebKit fork (Agent 1) successor.
//   • DRIVER=playwright + PLAYWRIGHT_BROWSER selector framing.
//   • Trade-offs framing pinned: Playwright WebKit ≠ Driftstack-
//     modified WebKit + no iPhone-archetype mapping (viewport + UA
//     only) + single-context-per-session.
//   • What-this-driver-IS-for framing: founder local dev + CI E2E.
//   • What-this-driver-is-NOT-for framing: production customer
//     traffic ('The WebKit fork is the only production-eligible
//     driver. PlaywrightDriver is dev/test only.').
//   • imports: chromium/firefox/webkit from @playwright/test; Driver
//     types from ./types; BadRequestError + DriverNotIntegratedError
//     from ../lib/errors.
//   • PlaywrightBrowserKind = 'webkit'|'chromium'|'firefox'.
//   • PlaywrightDriverConfig: browserKind required + headed default
//     false.
//   • Lazy browser launch framing pinned: 'Single shared Browser
//     instance across all sessions; per-session BrowserContext for
//     state isolation. Context is closed on destroy(). The Browser
//     itself is launched lazily on the first createSession + reused;
//     never closed (process exit reaps it).'
//   • createSession: best-effort iPhone-archetype mapping rationale;
//     5-field newContext args (viewport + userAgent +
//     deviceScaleFactor:3 + isMobile:true + hasTouch:true); session
//     id format `pw_${hex}_${unix-ms-base36}`.
//   • navigate: waitUntil 3-cases (networkidle|load|domcontentloaded
//     default).
//   • interact + guiInput + wait + capture 'pdf'|'state' → throw
//     DriverNotIntegratedError.
//   • capture 'screenshot' → page.screenshot + base64-encoding.
//   • destroy: context.close().catch swallow.
//   • requireSession: throws BadRequestError on missing session.
//   • approximateViewport: 3-case + default iPhone 16 Pro.
//   • approximateUserAgent: ios-26 special case + default.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/drivers/playwright.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W454.C apps/server/src/drivers/playwright.ts content parity', () => {
  const body = read(LIB);

  it("V-333b framing pinned: 'V-333b — Playwright-backed driver. Foundation for self-hosted local dev + E2E testing on the Mac BEFORE the WebKit fork (Agent 1) lands the production driver. Selecting via DRIVER=playwright + PLAYWRIGHT_BROWSER=webkit|chromium|firefox.'", () => {
    expect(body).toMatch(
      /\/\/ V-333b — Playwright-backed driver\. Foundation for self-hosted local\s*\/\/ dev \+ E2E testing on the Mac BEFORE the WebKit fork \(Agent 1\) lands\s*\/\/ the production driver\. Selecting via DRIVER=playwright \+\s*\/\/ PLAYWRIGHT_BROWSER=webkit\|chromium\|firefox\./,
    );
  });

  it("Trade-offs framing pinned: 'Playwright's WebKit channel is the same WebKit upstream; it does NOT include the Driftstack source modifications.' + no iPhone-archetype mapping (viewport + UA only) + single-context-per-session", () => {
    expect(body).toMatch(
      /\/\/\s*- Playwright's WebKit channel is the same WebKit upstream; it\s*\/\/\s*does NOT include the Driftstack source modifications\. Sites\s*\/\/\s*that fingerprint at the WebKit C\+\+ layer will see "vanilla"\s*\/\/\s*WebKit\. Adequate for non-stealth E2E tests; insufficient for\s*\/\/\s*evaluating fingerprint quality against production targets\./,
    );
    expect(body).toMatch(
      /\/\/\s*- No iPhone-archetype mapping \(no audio\/screen\/HW concurrency\s*\/\/\s*overrides\)\. Each archetype just maps to a viewport \+ UA string\s*\/\/\s*that approximates iPhone-Safari\. The real driver does much\s*\/\/\s*more\./,
    );
    expect(body).toMatch(
      /\/\/\s*- Single-context-per-session keeps memory bounded; no profile\s*\/\/\s*persistence yet \(V-333c follow-on\)\./,
    );
  });

  it('What-this-driver-IS-for framing pinned: founder local dev + CI E2E without spinning up WebKit fork', () => {
    expect(body).toMatch(
      /\/\/ What this DRIVER IS for:\s*\/\/\s*- Founder running the API \+ GUI on their Mac and verifying the\s*\/\/\s*full session create\/navigate\/destroy flow against a real\s*\/\/\s*browser without waiting on Agent 1\./,
    );
    expect(body).toMatch(
      /\/\/\s*- CI E2E tests of the route layer \+ service layer against a\s*\/\/\s*real browser, without spinning up the WebKit fork\./,
    );
  });

  it("Production-rejection framing pinned: 'What this DRIVER is NOT for: Production customer traffic. The WebKit fork is the only production-eligible driver. PlaywrightDriver is dev/test only.'", () => {
    expect(body).toMatch(
      /\/\/ What this DRIVER is NOT for:\s*\/\/\s*- Production customer traffic\. The WebKit fork is the only\s*\/\/\s*production-eligible driver\. PlaywrightDriver is dev\/test only\./,
    );
  });

  it('imports: chromium/firefox/webkit + Browser/BrowserContext/Page types from @playwright/test; BadRequestError + DriverNotIntegratedError from ../lib/errors; 18 driver types', () => {
    expect(body).toMatch(/import \{ chromium, firefox, webkit \} from '@playwright\/test';/);
    expect(body).toMatch(
      /import type \{ Browser, BrowserContext, Page \} from '@playwright\/test';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, DriverNotIntegratedError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import type \{\s*CaptureInput,\s*CaptureResult,\s*ExtractInput,\s*ExtractResult,\s*SearchInput,\s*SearchResult,\s*LoginInput,\s*LoginResult,\s*CreateSessionInput,\s*CreateSessionResult,\s*Driver,\s*DriverSessionId,\s*GUIInputInput,\s*GUIInputResult,\s*InteractInput,\s*InteractResult,\s*NavigateInput,\s*NavigateResult,\s*SessionStateResult,\s*WaitInput,\s*WaitResult,\s*\} from '\.\/types\.js';/,
    );
  });

  it("PlaywrightBrowserKind 3-value union; PlaywrightDriverConfig: browserKind required + optional headed framing 'true to launch a visible browser window (great for local Mac dev / debugging). false to run headless (CI). Default false.'", () => {
    expect(body).toMatch(
      /export type PlaywrightBrowserKind = 'webkit' \| 'chromium' \| 'firefox';/,
    );
    expect(body).toMatch(
      /\*\s*`true` to launch a visible browser window \(great for local Mac\s*\*\s*dev \/ debugging\)\. `false` to run headless \(CI\)\. Default false\./,
    );
  });

  it("PlaywrightDriver class framing pinned: 'Single shared Browser instance across all sessions; per-session BrowserContext for state isolation. Context is closed on destroy(). The Browser itself is launched lazily on the first createSession + reused; never closed (process exit reaps it).'", () => {
    expect(body).toMatch(
      /\* V-333b — Playwright driver\.[\s\S]*?\*\s*Single shared `Browser` instance across all sessions; per-session\s*\*\s*`BrowserContext` for state isolation\. Context is closed on\s*\*\s*`destroy\(\)`\. The Browser itself is launched lazily on the first\s*\*\s*createSession \+ reused; never closed \(process exit reaps it\)\./,
    );
    expect(body).toContain("readonly searchCapability = 'unavailable' as const;");
    expect(body).toContain("readonly loginCapability = 'unavailable' as const;");
  });

  it('getBrowser: 3-branch ternary (chromium|firefox|webkit default); browserPromise lazy-init; HEADED-INVERSION GUARD: headless: this.config.headed !== true (dropping !== inverts behavior)', () => {
    expect(body).toMatch(
      /const launcher =\s*this\.config\.browserKind === 'chromium'\s*\? chromium\s*: this\.config\.browserKind === 'firefox'\s*\? firefox\s*: webkit;/,
    );
    expect(body).toMatch(
      /this\.browserPromise = launcher\.launch\(\{ headless: this\.config\.headed !== true \}\);/,
    );
  });

  it("createSession framing pinned: 'best-effort iPhone-archetype mapping. Real archetypes are richer (HW concurrency, audio API tells, etc.); this just sets the viewport + UA so basic fingerprinting works.' + 5-field newContext (viewport + userAgent + deviceScaleFactor:3 + isMobile:true + hasTouch:true)", () => {
    expect(body).toMatch(
      /\/\/ V-333b — best-effort iPhone-archetype mapping\. Real archetypes\s*\/\/ are richer \(HW concurrency, audio API tells, etc\.\); this just\s*\/\/ sets the viewport \+ UA so basic fingerprinting works\./,
    );
    expect(body).toMatch(
      /const context = await browser\.newContext\(\{\s*viewport,\s*userAgent,\s*deviceScaleFactor: 3,\s*isMobile: true,\s*hasTouch: true,\s*\}\);/,
    );
  });

  it("Session id framing pinned: 'Synthetic session id — playwright doesn't expose a stable public guid on BrowserContext, so we generate our own. Format: pw_<random-hex>_<unix-ms-base36>.'", () => {
    expect(body).toMatch(
      /\/\/ Synthetic session id — playwright doesn't expose a stable\s*\/\/ public guid on BrowserContext, so we generate our own\.\s*\/\/ Format: pw_<random-hex>_<unix-ms-base36>\./,
    );
    expect(body).toMatch(
      /const sessionId = `pw_\$\{Math\.floor\(Math\.random\(\) \* 0xffffffff\)\s*\.toString\(16\)\s*\.padStart\(8, '0'\)\}_\$\{Date\.now\(\)\.toString\(36\)\}`;/,
    );
  });

  it("navigate: 3-branch ternary on input.waitUntil ('networkidle'|'load'|else 'domcontentloaded' default); response status fallback 0", () => {
    expect(body).toMatch(
      /waitUntil:\s*input\.waitUntil === 'networkidle'\s*\? 'networkidle'\s*: input\.waitUntil === 'load'\s*\? 'load'\s*: 'domcontentloaded',/,
    );
    expect(body).toMatch(/status: response\?\.status\(\) \?\? 0,/);
  });

  it("interact / guiInput / wait → throw DriverNotIntegratedError framing pinned 'PlaywrightDriver returns a NotIntegrated shape for surfaces that haven't been minimally wired so the gap is loud + visible.'", () => {
    expect(body).toMatch(
      /\/\/ V-333b — interact \/ wait \/ capture \/ getState have minimal\s*\/\/ Playwright mappings sufficient for E2E smoke testing\. The full\s*\/\/ semantic surface \(recipe library, behavioral simulation,\s*\/\/ recapture-automation\) is NOT modeled here; that's the production\s*\/\/ WebKitDriver's job\. PlaywrightDriver returns a NotIntegrated\s*\/\/ shape for surfaces that haven't been minimally wired so the gap\s*\/\/ is loud \+ visible\./,
    );
    expect(body).toMatch(
      /async interact\([\s\S]*?\): Promise<InteractResult> \{\s*await Promise\.resolve\(\);\s*throw new DriverNotIntegratedError\(\);\s*\}/,
    );
    expect(body).toMatch(
      /async guiInput\([\s\S]*?\): Promise<GUIInputResult> \{\s*await Promise\.resolve\(\);\s*throw new DriverNotIntegratedError\(\);\s*\}/,
    );
    expect(body).toMatch(
      /async wait\([\s\S]*?\): Promise<WaitResult> \{\s*await Promise\.resolve\(\);\s*throw new DriverNotIntegratedError\(\);\s*\}/,
    );
  });

  it("capture: 'screenshot' branch page.screenshot({fullPage}) + base64 encoding; non-screenshot ('state'/'pdf') → throw DriverNotIntegratedError; framing pinned 'state / pdf fall through; not yet wired.'", () => {
    expect(body).toMatch(
      /if \(input\.kind === 'screenshot'\) \{\s*const buf = await entry\.page\.screenshot\(\{ fullPage: input\.fullPage \}\);\s*return \{\s*kind: 'screenshot',\s*data: buf\.toString\('base64'\),\s*encoding: 'base64',\s*byteSize: buf\.byteLength,\s*durationMs: Date\.now\(\) - start,\s*\};\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ 'state' \/ 'pdf' fall through; not yet wired\.\s*throw new DriverNotIntegratedError\(\);/,
    );
  });

  it('destroy: context.close().catch(swallow); requireSession: throws BadRequestError on missing session', () => {
    expect(body).toMatch(
      /await entry\.context\.close\(\)\.catch\(\(\) => \{\s*\/\* swallow — best-effort \*\/\s*\}\);/,
    );
    expect(body).toMatch(
      /private requireSession\(sessionId: DriverSessionId\): SessionEntry \{\s*const entry = this\.sessions\.get\(sessionId\);\s*if \(!entry\) \{\s*throw new BadRequestError\(`Driver session "\$\{sessionId\}" not found\.`\);\s*\}\s*return entry;\s*\}/,
    );
  });

  it("approximateViewport: 3-case (iphone-16-pro 402x874 + iphone-15 393x852 + iphone-14 390x844) + default iPhone 16 Pro framing 'Defaults to iPhone 16 Pro dimensions when the archetype is unfamiliar.'", () => {
    expect(body).toMatch(
      /\* Best-effort archetype → viewport mapping\. Defaults to iPhone 16\s*\*\s*Pro dimensions when the archetype is unfamiliar\./,
    );
    expect(body).toMatch(
      /if \(archetype\.includes\('iphone-16-pro'\)\) return \{ width: 402, height: 874 \};/,
    );
    expect(body).toMatch(
      /if \(archetype\.includes\('iphone-15'\)\) return \{ width: 393, height: 852 \};/,
    );
    expect(body).toMatch(
      /if \(archetype\.includes\('iphone-14'\)\) return \{ width: 390, height: 844 \};/,
    );
    expect(body).toMatch(/return \{ width: 402, height: 874 \};/);
  });

  it('approximateUserAgent: ios-26 special case (WebKit 619.x family Safari 17.4) + default (iOS 17.4 fallback) framing pinned \'Real driver picks a UA per the exact iOS / Safari combo; this is "good enough" for fingerprint-permissive sites.\'', () => {
    expect(body).toMatch(
      /\* Best-effort archetype → UA mapping\. Real driver picks a UA per the\s*\*\s*exact iOS \/ Safari combo; this is "good enough" for fingerprint-\s*\*\s*permissive sites\./,
    );
    expect(body).toMatch(/\/\/ iOS 26\.4\.1 = WebKit 619\.x family; Safari ~17\.4 corresponds\./);
    expect(body).toMatch(
      /'Mozilla\/5\.0 \(iPhone; CPU iPhone OS 26_4_1 like Mac OS X\) AppleWebKit\/619\.1\.26 \(KHTML, like Gecko\) Version\/26\.0 Mobile\/15E148 Safari\/619\.1'/,
    );
    expect(body).toMatch(
      /'Mozilla\/5\.0 \(iPhone; CPU iPhone OS 17_4 like Mac OS X\) AppleWebKit\/605\.1\.15 \(KHTML, like Gecko\) Version\/17\.4 Mobile\/15E148 Safari\/604\.1'/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
