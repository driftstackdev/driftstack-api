// V-333b — Playwright-backed driver. Foundation for self-hosted local
// dev + E2E testing on the Mac BEFORE the WebKit fork (Agent 1) lands
// the production driver. Selecting via DRIVER=playwright +
// PLAYWRIGHT_BROWSER=webkit|chromium|firefox.
//
// Trade-offs vs the eventual WebKitDriver (real fork):
//   - Playwright's WebKit channel is the same WebKit upstream; it
//     does NOT include the Driftstack source modifications. Sites
//     that fingerprint at the WebKit C++ layer will see "vanilla"
//     WebKit. Adequate for non-stealth E2E tests; insufficient for
//     evaluating fingerprint quality against production targets.
//   - No iPhone-archetype mapping (no audio/screen/HW concurrency
//     overrides). Each archetype just maps to a viewport + UA string
//     that approximates iPhone-Safari. The real driver does much
//     more.
//   - Single-context-per-session keeps memory bounded; no profile
//     persistence yet (V-333c follow-on).
//
// What this DRIVER IS for:
//   - Founder running the API + GUI on their Mac and verifying the
//     full session create/navigate/destroy flow against a real
//     browser without waiting on Agent 1.
//   - CI E2E tests of the route layer + service layer against a
//     real browser, without spinning up the WebKit fork.
//
// What this DRIVER is NOT for:
//   - Production customer traffic. The WebKit fork is the only
//     production-eligible driver. PlaywrightDriver is dev/test only.

import { chromium, firefox, webkit } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { BadRequestError, DriverNotIntegratedError } from '../lib/errors.js';
import type {
  CaptureInput,
  CaptureResult,
  ExtractInput,
  ExtractResult,
  SearchInput,
  SearchResult,
  LoginInput,
  LoginResult,
  CreateSessionInput,
  CreateSessionResult,
  Driver,
  DriverSessionId,
  GUIInputInput,
  GUIInputResult,
  InteractInput,
  InteractResult,
  NavigateInput,
  NavigateResult,
  SessionStateResult,
  WaitInput,
  WaitResult,
} from './types.js';

export type PlaywrightBrowserKind = 'webkit' | 'chromium' | 'firefox';

export interface PlaywrightDriverConfig {
  browserKind: PlaywrightBrowserKind;
  /**
   * `true` to launch a visible browser window (great for local Mac
   * dev / debugging). `false` to run headless (CI). Default false.
   */
  headed?: boolean;
}

interface SessionEntry {
  context: BrowserContext;
  page: Page;
  createdAt: Date;
}

/**
 * V-333b — Playwright driver.
 *
 * Single shared `Browser` instance across all sessions; per-session
 * `BrowserContext` for state isolation. Context is closed on
 * `destroy()`. The Browser itself is launched lazily on the first
 * createSession + reused; never closed (process exit reaps it).
 */
export class PlaywrightDriver implements Driver {
  readonly searchCapability = 'unavailable' as const;
  readonly loginCapability = 'unavailable' as const;
  private browserPromise: Promise<Browser> | null = null;
  private readonly sessions = new Map<DriverSessionId, SessionEntry>();

  constructor(private readonly config: PlaywrightDriverConfig) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) return this.browserPromise;
    const launcher =
      this.config.browserKind === 'chromium'
        ? chromium
        : this.config.browserKind === 'firefox'
          ? firefox
          : webkit;
    this.browserPromise = launcher.launch({ headless: this.config.headed !== true });
    return this.browserPromise;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const browser = await this.getBrowser();
    // V-333b — best-effort iPhone-archetype mapping. Real archetypes
    // are richer (HW concurrency, audio API tells, etc.); this just
    // sets the viewport + UA so basic fingerprinting works.
    const viewport = approximateViewport(input.archetype);
    const userAgent = approximateUserAgent(input.archetype);
    const context = await browser.newContext({
      viewport,
      userAgent,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // Synthetic session id — playwright doesn't expose a stable
    // public guid on BrowserContext, so we generate our own.
    // Format: pw_<random-hex>_<unix-ms-base36>.
    const sessionId = `pw_${Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0')}_${Date.now().toString(36)}`;
    this.sessions.set(sessionId, { context, page, createdAt: new Date() });
    return { driverSessionId: sessionId };
  }

  async navigate(sessionId: DriverSessionId, input: NavigateInput): Promise<NavigateResult> {
    const entry = this.requireSession(sessionId);
    const start = Date.now();
    const response = await entry.page.goto(input.url, {
      timeout: input.timeoutMs,
      waitUntil:
        input.waitUntil === 'networkidle'
          ? 'networkidle'
          : input.waitUntil === 'load'
            ? 'load'
            : 'domcontentloaded',
    });
    const durationMs = Date.now() - start;
    return {
      url: input.url,
      finalUrl: entry.page.url(),
      status: response?.status() ?? 0,
      durationMs,
    };
  }

  // V-333b — interact / wait / capture / getState have minimal
  // Playwright mappings sufficient for E2E smoke testing. The full
  // semantic surface (recipe library, behavioral simulation,
  // recapture-automation) is NOT modeled here; that's the production
  // WebKitDriver's job. PlaywrightDriver returns a NotIntegrated
  // shape for surfaces that haven't been minimally wired so the gap
  // is loud + visible.
  async interact(_sessionId: DriverSessionId, _input: InteractInput): Promise<InteractResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }

  async guiInput(_sessionId: DriverSessionId, _input: GUIInputInput): Promise<GUIInputResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }

  async wait(_sessionId: DriverSessionId, _input: WaitInput): Promise<WaitResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }

  async getState(sessionId: DriverSessionId): Promise<SessionStateResult> {
    const entry = this.requireSession(sessionId);
    const url = entry.page.url();
    const title = await entry.page.title().catch(() => null);
    const cookies = await entry.context.cookies();
    return {
      url: url || null,
      title,
      // Cookies object passes through; consumer treats as opaque.
      cookies: cookies.map((c) => ({ ...c })),
      localStorage: {},
      // W615 — minimal lifecycle mapping (smoke-test driver): loaded once
      // a page URL exists; richer errored/loading detail is the real
      // harness's job (A3 emit).
      pageState: url ? { state: 'loaded' as const } : null,
      capturedAt: new Date(),
    };
  }

  async capture(sessionId: DriverSessionId, input: CaptureInput): Promise<CaptureResult> {
    const entry = this.requireSession(sessionId);
    const start = Date.now();
    if (input.kind === 'screenshot') {
      const buf = await entry.page.screenshot({ fullPage: input.fullPage });
      return {
        kind: 'screenshot',
        data: buf.toString('base64'),
        encoding: 'base64',
        byteSize: buf.byteLength,
        durationMs: Date.now() - start,
      };
    }
    // 'state' / 'pdf' fall through; not yet wired.
    throw new DriverNotIntegratedError();
  }

  async extract(_sessionId: DriverSessionId, _input: ExtractInput): Promise<ExtractResult> {
    // Real DOM extraction in the Playwright (local-dev) driver is a follow-up —
    // it needs in-page page.evaluate DOM logic (DOM lib not in the server
    // tsconfig). The production path is the WebKit driver (harness `extract`
    // intent, A3 W456) + the mock driver covers the default + tests.
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }

  async search(_sessionId: DriverSessionId, _input: SearchInput): Promise<SearchResult> {
    // Like extract: the real query-type+submit+wait flow is the WebKit driver's
    // harness `search` intent; the Playwright local-dev impl is a follow-up.
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }

  async login(_sessionId: DriverSessionId, _input: LoginInput): Promise<LoginResult> {
    // Real heuristic credential login is the WebKit driver's harness `login`
    // intent; the Playwright local-dev impl is a follow-up.
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }

  async destroy(sessionId: DriverSessionId): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    await entry.context.close().catch(() => {
      /* swallow — best-effort */
    });
  }

  private requireSession(sessionId: DriverSessionId): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new BadRequestError(`Driver session "${sessionId}" not found.`);
    }
    return entry;
  }
}

/**
 * Best-effort archetype → viewport mapping. Defaults to iPhone 16
 * Pro dimensions when the archetype is unfamiliar.
 */
function approximateViewport(archetype: string): { width: number; height: number } {
  if (archetype.includes('iphone-16-pro')) return { width: 402, height: 874 };
  if (archetype.includes('iphone-15')) return { width: 393, height: 852 };
  if (archetype.includes('iphone-14')) return { width: 390, height: 844 };
  return { width: 402, height: 874 };
}

/**
 * Best-effort archetype → UA mapping. Real driver picks a UA per the
 * exact iOS / Safari combo; this is "good enough" for fingerprint-
 * permissive sites.
 */
function approximateUserAgent(archetype: string): string {
  // iOS 26.4.1 = WebKit 619.x family; Safari ~17.4 corresponds.
  if (archetype.includes('ios-26')) {
    return 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X) AppleWebKit/619.1.26 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/619.1';
  }
  return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
}
