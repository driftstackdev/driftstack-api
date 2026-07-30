// Mock WebKit driver — in-memory, deterministic.
//
// The mock simulates real WebKit behaviour at the contract level:
//   - createSession returns a deterministic driver session id (counter-based)
//   - navigate/interact/wait honour configurable latency from .env
//   - getState returns canned, deterministic data per session
//   - capture returns canned bytes (small base64-encoded blob for screenshots)
//   - destroy is idempotent
//
// Error simulation lets tests exercise every error path the real driver
// will produce. A "trigger" host or selector causes the mock to throw the
// matching error — see TRIGGER_HOSTS and TRIGGER_SELECTORS below.
//
// This driver is deterministic by design: same inputs → same outputs. Real
// WebKit will introduce variance from network conditions, page randomness,
// etc.; the mock does NOT. Anything that needs randomness has to be tested
// against the real driver.

import { setTimeout as sleep } from 'node:timers/promises';
import { DriverError, SessionTimeoutError } from '../lib/errors.js';
import type { BehavioralProfile } from '@driftstack/api-types';
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

// ───────────────────────────────────────────────────────────────────────────
// Trigger inputs that produce specific error paths
// ───────────────────────────────────────────────────────────────────────────

const TRIGGER_HOSTS = {
  /** Navigation throws DriverError (network failure simulation). */
  networkError: 'error.driftstack-mock.test',
  /** Navigation hangs past timeout. */
  timeout: 'timeout.driftstack-mock.test',
  /** Navigation returns HTTP 4xx/5xx. */
  http500: 'http500.driftstack-mock.test',
} as const;

const TRIGGER_SELECTORS = {
  /** interact/wait fails because the selector matches nothing. */
  notFound: '#nonexistent',
  /** interact times out (element exists but never becomes interactable). */
  hangs: '#hangs',
} as const;

// 1×1 transparent PNG, base64-encoded — used as canned screenshot payload.
const PNG_1X1_TRANSPARENT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

// ───────────────────────────────────────────────────────────────────────────
// Internal session state
// ───────────────────────────────────────────────────────────────────────────

interface InternalSession {
  driverSessionId: DriverSessionId;
  archetype: string;
  /** V-169 — captured for test inspection; mock doesn't act on it. */
  purpose: 'production_customer' | 'cumulative_rig_validation' | 'test_domain_probe';
  /** Behavioural persona — captured for test inspection; mock doesn't act on it. */
  behavioralProfile: BehavioralProfile | undefined;
  currentUrl: string | null;
  currentTitle: string | null;
  destroyed: boolean;
  /** Sequence counter incremented on every operation; lets tests reason about ordering. */
  opSeq: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Driver
// ───────────────────────────────────────────────────────────────────────────

export interface MockDriverOptions {
  /** Per-call simulated latency for navigate. */
  navigateLatencyMs?: number;
  /** Per-call simulated latency for interact/wait. */
  interactLatencyMs?: number;
  /**
   * If true, replace `await sleep(ms)` with a no-op so tests run fast.
   * Production-like usage (npm run dev) should leave this false.
   */
  fastForwardLatency?: boolean;
}

export class MockDriver implements Driver {
  readonly searchCapability = 'simulation' as const;
  readonly loginCapability = 'simulation' as const;
  private readonly sessions = new Map<DriverSessionId, InternalSession>();
  private nextId = 1;
  private readonly navigateLatencyMs: number;
  private readonly interactLatencyMs: number;
  private readonly fastForward: boolean;

  constructor(opts: MockDriverOptions = {}) {
    this.navigateLatencyMs = opts.navigateLatencyMs ?? 120;
    this.interactLatencyMs = opts.interactLatencyMs ?? 40;
    this.fastForward = opts.fastForwardLatency ?? false;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    await Promise.resolve();
    const id = `mock_ses_${this.nextId.toString().padStart(8, '0')}`;
    this.nextId += 1;
    this.sessions.set(id, {
      driverSessionId: id,
      archetype: input.archetype,
      purpose: input.purpose,
      behavioralProfile: input.behavioralProfile,
      currentUrl: null,
      currentTitle: null,
      destroyed: false,
      opSeq: 0,
    });
    return { driverSessionId: id };
  }

  async navigate(sessionId: DriverSessionId, input: NavigateInput): Promise<NavigateResult> {
    const session = this.requireSession(sessionId);

    let host = '';
    try {
      host = new URL(input.url).host;
    } catch {
      throw new DriverError(`Invalid URL: ${input.url}`);
    }

    if (host === TRIGGER_HOSTS.networkError) {
      throw new DriverError('Simulated network failure', { url: input.url });
    }

    if (host === TRIGGER_HOSTS.timeout) {
      // Pretend to hang for the full timeout, then throw.
      await this.sleep(input.timeoutMs);
      throw new SessionTimeoutError(input.timeoutMs);
    }

    const httpStatus = host === TRIGGER_HOSTS.http500 ? 500 : 200;

    const start = Date.now();
    await this.sleep(this.navigateLatencyMs);
    const duration = Date.now() - start;

    session.currentUrl = input.url;
    session.currentTitle = `Mock page for ${host}`;
    session.opSeq += 1;

    return {
      url: input.url,
      finalUrl: input.url,
      status: httpStatus,
      durationMs: duration,
    };
  }

  async interact(sessionId: DriverSessionId, input: InteractInput): Promise<InteractResult> {
    const session = this.requireSession(sessionId);

    const selector = 'selector' in input.action ? input.action.selector : undefined;
    if (selector === TRIGGER_SELECTORS.notFound) {
      throw new DriverError(`Selector not found: ${selector}`, { selector });
    }
    if (selector === TRIGGER_SELECTORS.hangs) {
      await this.sleep(input.timeoutMs);
      throw new SessionTimeoutError(input.timeoutMs);
    }

    const start = Date.now();
    await this.sleep(this.interactLatencyMs);
    session.opSeq += 1;
    return { durationMs: Date.now() - start };
  }

  async guiInput(sessionId: DriverSessionId, _input: GUIInputInput): Promise<GUIInputResult> {
    const session = this.requireSession(sessionId);
    const start = Date.now();
    await this.sleep(this.interactLatencyMs);
    session.opSeq += 1;
    return { durationMs: Date.now() - start };
  }

  async wait(sessionId: DriverSessionId, input: WaitInput): Promise<WaitResult> {
    this.requireSession(sessionId);

    if (input.condition.kind === 'time') {
      const ms = Math.min(input.condition.ms, input.timeoutMs);
      const start = Date.now();
      await this.sleep(ms);
      return { satisfied: true, durationMs: Date.now() - start };
    }

    if (
      input.condition.kind === 'selector' &&
      input.condition.selector === TRIGGER_SELECTORS.notFound
    ) {
      // Wait for selector that never appears: time out, satisfied=false.
      await this.sleep(input.timeoutMs);
      return { satisfied: false, durationMs: input.timeoutMs };
    }

    // Default mock behaviour: condition is "satisfied" after interactLatencyMs.
    const start = Date.now();
    await this.sleep(this.interactLatencyMs);
    return { satisfied: true, durationMs: Date.now() - start };
  }

  async getState(sessionId: DriverSessionId): Promise<SessionStateResult> {
    await Promise.resolve();
    const session = this.requireSession(sessionId);
    return {
      url: session.currentUrl,
      title: session.currentTitle,
      cookies: [],
      localStorage: {},
      // W615 — deterministic lifecycle: a page is 'loaded' once navigated,
      // null before any navigation (mirrors what a real harness would
      // report for an idle session).
      pageState: session.currentUrl !== null ? { state: 'loaded' } : null,
      capturedAt: new Date(),
    };
  }

  async capture(sessionId: DriverSessionId, input: CaptureInput): Promise<CaptureResult> {
    this.requireSession(sessionId);

    const start = Date.now();
    await this.sleep(this.interactLatencyMs);

    if (input.kind === 'screenshot') {
      return {
        kind: 'screenshot',
        data: PNG_1X1_TRANSPARENT_BASE64,
        encoding: 'base64',
        byteSize: Math.floor((PNG_1X1_TRANSPARENT_BASE64.length * 3) / 4),
        durationMs: Date.now() - start,
      };
    }

    if (input.kind === 'dom_snapshot') {
      const dom = '<!doctype html><html><body>mock</body></html>';
      return {
        kind: 'dom_snapshot',
        data: dom,
        encoding: 'utf8',
        byteSize: Buffer.byteLength(dom, 'utf8'),
        durationMs: Date.now() - start,
      };
    }

    // pdf
    const pdfStub = Buffer.from('%PDF-1.4\nmock-pdf').toString('base64');
    return {
      kind: 'pdf',
      data: pdfStub,
      encoding: 'base64',
      byteSize: Math.floor((pdfStub.length * 3) / 4),
      durationMs: Date.now() - start,
    };
  }

  async extract(sessionId: DriverSessionId, input: ExtractInput): Promise<ExtractResult> {
    this.requireSession(sessionId);
    const start = Date.now();
    await this.sleep(this.interactLatencyMs);
    // Synthetic, type-faithful values per extraction (the real extraction runs
    // in the WebKit driver against the page). Shapes match the contract: text →
    // string (number when transform:'number'), attribute → string, list →
    // array (of sub-objects when `extract` given, else strings).
    const value: Record<string, unknown> = {};
    for (const e of input.extractions) {
      if (e.type === 'list') {
        value[e.name] = e.extract
          ? [Object.fromEntries(Object.keys(e.extract).map((f) => [f, `mock-${f}`]))]
          : [`mock-${e.name}-0`, `mock-${e.name}-1`];
      } else if (e.type === 'attribute') {
        value[e.name] = `mock-${e.attribute ?? 'attr'}`;
      } else {
        value[e.name] = e.transform === 'number' ? 0 : `mock-${e.name}`;
      }
    }
    return { value, durationMs: Date.now() - start };
  }

  async search(sessionId: DriverSessionId, input: SearchInput): Promise<SearchResult> {
    this.requireSession(sessionId);
    const start = Date.now();
    await this.sleep(this.interactLatencyMs);
    // The real search (type query + submit + optional wait) runs in the WebKit
    // driver. The mock reports submit per the input and, when a results
    // selector was given, a synthetic visible result.
    return {
      submitted: input.submit,
      queryTruncated: false,
      ...(input.waitForResultsSelector !== undefined ? { resultsVisible: true } : {}),
      durationMs: Date.now() - start,
    };
  }

  async login(sessionId: DriverSessionId, _input: LoginInput): Promise<LoginResult> {
    this.requireSession(sessionId);
    const start = Date.now();
    await this.sleep(this.interactLatencyMs);
    // The real heuristic login (type credentials + submit + assess) runs in the
    // WebKit driver. The mock reports a successful login (never echoes the
    // password — _input is unused).
    return {
      submitted: true,
      credentialsTruncated: false,
      loggedIn: true,
      postLoginUrl: 'https://example.com/account',
      durationMs: Date.now() - start,
    };
  }

  async destroy(sessionId: DriverSessionId): Promise<void> {
    await Promise.resolve();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.destroyed = true;
      this.sessions.delete(sessionId);
    }
    // Idempotent — destroying an unknown session is a no-op.
  }

  // ─────────────────────────────────────────────────────────────────────────

  private requireSession(id: DriverSessionId): InternalSession {
    const session = this.sessions.get(id);
    if (!session || session.destroyed) {
      throw new DriverError(`Driver session not found: ${id}`);
    }
    return session;
  }

  private async sleep(ms: number): Promise<void> {
    if (this.fastForward || ms <= 0) return;
    await sleep(ms);
  }
}
