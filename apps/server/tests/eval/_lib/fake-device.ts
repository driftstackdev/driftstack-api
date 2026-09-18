// The fake device: a pure function of (IntentDispatch, DeviceState).
//
// ⛔ IT IS INJECTED AT `IntentDispatcher`, NOT AT `AgentExecutor`. A fake
// executor would bypass every layer that actually breaks — the verb→harness
// mapping and its CSS-selector refusal, the wire envelope, the result→customer
// mapping and its diagnosis table, the retry/no-retry fences, the `wait`
// exemption and the consequential-action gate. Those layers ARE the subject.
//
// HONESTY MECHANISM (non-negotiable): the device never hand-constructs a
// `ParsedIntentResult`. It builds a real wire envelope with `encodeWireData` and
// returns `parseIntentResult(frame, intentName)`, which validates the payload
// against `HARNESS_INTENT_RESULT_SCHEMAS`. A device whose fiction drifts from
// the contract therefore fails loudly instead of feeding the agent loop a shape
// the real box never sends.

import type { IntentDispatcher } from '../../../src/services/agent-executor-control-plane.js';
import { NEVER_BECAME_VISIBLE } from './score.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../../src/services/harness-control-codec.js';
import {
  HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS,
  type HarnessErrorCode,
  type HarnessIntentName,
  type IntentDispatch,
} from '../../../src/schemas/harness-control-protocol.js';
import {
  notFoundPage,
  type ScriptedElement,
  type ScriptedPage,
  type SiteMap,
} from './page-model.js';
import type { VirtualClock } from './virtual-clock.js';

/** A 1x1 transparent PNG. Fixed bytes so a screenshot is byte-identical run to run. */
export const ONE_PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Keys the harness's `press_key` resolves. Anything else is a planning fault
 *  and comes back as `intent_invalid_parameter`, exactly as the real one does. */
const RESOLVABLE_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Simulated cost of an instantaneous device operation, so no step is free. */
const TRIVIAL_MS = 30;
const CLICK_MS = 120;
const TYPE_MS_PER_CHAR = 12;
const SCROLL_MS = 180;
/** How long the harness spends before giving up on a page that never loads. */
const NEVER_FINISHES_LOAD_MS = 30_000;
/** Reading pace used to cost a `behavioral_pause{kind:'reading'}`. */
const READING_MS_PER_WORD = 240;
const DEFAULT_PAUSE_MS = 1_500;

export interface DispatchRecord {
  ordinal: number;
  intentName: HarnessIntentName;
  params: Record<string, unknown>;
  success: boolean;
  errorCode?: HarnessErrorCode;
  /**
   * ⛔ The device's own sentence, carried because the CODE is not enough to say
   * what died. `intent_webdriver_failed` covers both "the element is there and
   * something is over it" and "it never became visible" — and a real device is
   * no more specific. Classifying on the code alone made the negative control
   * report a click intercepted on a page with NO ELEMENTS AT ALL, which is a
   * death reason that cannot happen. A report that misattributes one death
   * cannot be trusted about any of them.
   */
  errorMessage?: string;
  /** Simulated device time this single dispatch consumed. */
  deviceMs: number;
  urlBefore: string;
  urlAfter: string;
}

export interface FakeDeviceOptions {
  sites: SiteMap;
  startUrl: string;
  clock: VirtualClock;
  /** Inline result cap, mirroring the harness's own. Over-cap `get_page_source`
   *  fails with `result_too_large` rather than returning a truncated DOM. */
  pageSourceMaxChars?: number;
  /** Sessions the device treats as authenticated. Empty today — nothing threads
   *  credentials into a turn, which is the point F2 measures. */
  authenticatedHosts?: ReadonlySet<string>;
}

/**
 * The generated `wait_for` predicate carries no structured condition — only a
 * JS source string the device cannot evaluate. So it is discriminated on the
 * generated TEXT.
 *
 * ⚠️ THIS IS THE ONE PLACE THE DEVICE GUESSES, AND IT SAYS SO. Any edit to the
 * predicate builders in `agent-intent-to-dispatch.ts` silently reclassifies
 * every wait in the corpus, so `agent-eval-wait-discriminator.test.ts` pins both
 * forms against what the mapper emits TODAY and asserts that a predicate
 * matching neither branch THROWS. A fallback to "condition satisfied" would turn
 * every wait in the corpus green for a reason that is not a fact.
 */
export type WaitPredicateKind = { kind: 'selector_visible'; selector: string } | { kind: 'idle' };

const DEEP_QUERY_RE = /const element = deepQuery\(("(?:[^"\\]|\\.)*")\);/;
const IDLE_SENTINEL = "Symbol.for('idle-settle.v1')";

export class UnknownWaitPredicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownWaitPredicateError';
  }
}

export function classifyWaitPredicate(predicate: string): WaitPredicateKind {
  const selectorMatch = DEEP_QUERY_RE.exec(predicate);
  const looksIdle = predicate.includes(IDLE_SENTINEL);
  if (selectorMatch !== null && looksIdle) {
    throw new UnknownWaitPredicateError(
      'wait predicate matched BOTH discriminators — the mapper changed and the device cannot tell the two waits apart',
    );
  }
  if (selectorMatch !== null) {
    const literal = selectorMatch[1];
    if (literal === undefined) {
      throw new UnknownWaitPredicateError('deepQuery matched with no selector literal');
    }
    return { kind: 'selector_visible', selector: JSON.parse(literal) as string };
  }
  if (looksIdle) return { kind: 'idle' };
  throw new UnknownWaitPredicateError(
    'wait predicate matched NEITHER discriminator — re-read agent-intent-to-dispatch.ts and update the device before trusting any wait in this corpus',
  );
}

export class FakeDevice {
  private readonly sites: SiteMap;
  private readonly clock: VirtualClock;
  private readonly pageSourceMaxChars: number;
  private readonly authenticatedHosts: ReadonlySet<string>;

  private currentUrl: string;
  private scrollPx = 0;
  private readonly dismissed = new Set<string>();
  private readonly revealed = new Set<string>();
  private readonly typed = new Map<string, string>();
  private readonly flagsSet = new Set<string>();
  private readonly settledUrls = new Set<string>();
  private readonly records: DispatchRecord[] = [];
  private deviceMsTotal = 0;

  constructor(opts: FakeDeviceOptions) {
    this.sites = opts.sites;
    this.clock = opts.clock;
    this.pageSourceMaxChars = opts.pageSourceMaxChars ?? 8 * 1024 * 1024;
    this.authenticatedHosts = opts.authenticatedHosts ?? new Set<string>();
    this.currentUrl = opts.startUrl;
  }

  /**
   * The port the executor is constructed with.
   *
   * The real dispatcher never rejects — a transport failure comes back as a
   * failure result. This one keeps that contract for everything it models, and
   * REJECTS only when it has no model at all, because a device that invents a
   * result for an unmodelled intent makes an untested dispatch path look tested.
   */
  readonly dispatcher: IntentDispatcher = {
    dispatch: (dispatch: IntentDispatch): Promise<ParsedIntentResult> => {
      try {
        return Promise.resolve(this.handle(dispatch));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };

  dispatches(): ReadonlyArray<DispatchRecord> {
    return this.records;
  }

  deviceMs(): number {
    return this.deviceMsTotal;
  }

  hasFlag(flag: string): boolean {
    return this.flagsSet.has(flag);
  }

  /** Durable state the device actually reached — how a task asserts that the
   *  thing the customer asked for HAPPENED, rather than that a step went green. */
  flags(): ReadonlySet<string> {
    return this.flagsSet;
  }

  url(): string {
    return this.currentUrl;
  }

  // ── dispatch ────────────────────────────────────────────────────────

  private handle(dispatch: IntentDispatch): ParsedIntentResult {
    const params = decodeWireData(dispatch.inputParams) as Record<string, unknown>;
    const urlBefore = this.currentUrl;
    const before = this.clock.now();
    const outcome = this.execute(dispatch.intentName, params);
    const deviceMs = this.clock.now() - before;
    this.deviceMsTotal += deviceMs;
    this.records.push({
      ordinal: this.records.length,
      intentName: dispatch.intentName,
      params,
      success: outcome.ok,
      ...(outcome.ok
        ? {}
        : {
            errorCode: outcome.errorCode,
            ...(outcome.message === undefined ? {} : { errorMessage: outcome.message }),
          }),
      deviceMs,
      urlBefore,
      urlAfter: this.currentUrl,
    });
    const frame = outcome.ok
      ? {
          type: 'intentResult',
          sessionId: dispatch.sessionId,
          intentId: dispatch.intentId,
          success: true,
          durationMs: deviceMs,
          outputData: encodeWireData(outcome.output),
        }
      : {
          type: 'intentResult',
          sessionId: dispatch.sessionId,
          intentId: dispatch.intentId,
          success: false,
          durationMs: deviceMs,
          errorCode: outcome.errorCode,
          ...(outcome.message !== undefined ? { errorMessage: outcome.message } : {}),
        };
    // The contract check. A drifted fiction dies here, not in the agent loop.
    return parseIntentResult(frame, dispatch.intentName);
  }

  private execute(intentName: HarnessIntentName, params: Record<string, unknown>): DeviceOutcome {
    switch (intentName) {
      case 'navigate':
        return this.doNavigate(readString(params, 'url'));
      case 'click':
        return this.doClick(readString(params, 'value'));
      case 'send_keys':
        return this.doSendKeys(readString(params, 'value'), readString(params, 'text'));
      case 'press_key':
        return this.doPressKey(readString(params, 'key'));
      case 'wait_for':
        return this.doWaitFor(params);
      case 'screenshot':
        this.cost(TRIVIAL_MS);
        return {
          ok: true,
          output: {
            screenshot_b64: ONE_PIXEL_PNG_B64,
            format: 'png',
            full_page: false,
            annotated: false,
          },
        };
      case 'get_page_source':
        return this.doGetPageSource();
      case 'scroll':
        return this.doScroll(params);
      case 'behavioral_pause':
        return this.doBehavioralPause(params);
      case 'extract':
        // Implemented so a future perceive/extract planner needs no device
        // change. `agent-eval-suite.test.ts` asserts it sees ZERO traffic today,
        // because no AgentIntent maps to it.
        return this.doExtract(params);
      default:
        // A name the corpus has never dispatched reached the device, which means
        // the mapper gained a target. Failing loudly beats inventing a result:
        // a quiet success here would make a brand-new dispatch path look tested.
        throw new Error(
          `fake device has no model for harness intent "${intentName}" — the mapper emits something this corpus has never measured`,
        );
    }
  }

  // ── per-intent behaviour ────────────────────────────────────────────

  private doNavigate(url: string): DeviceOutcome {
    const target = this.resolve(url);
    if (target.loadFails === true) {
      this.cost(target.loadMs);
      return {
        ok: false,
        errorCode: 'intent_page_load_failed',
        message: 'the load errored before the document was parsed',
      };
    }
    let landed = target;
    if (target.requiresAuth !== undefined && !this.authenticatedHosts.has(hostOf(target.url))) {
      landed = this.resolve(target.requiresAuth.loginUrl);
    } else if (target.redirectsTo !== undefined) {
      landed = this.resolve(target.redirectsTo);
    }
    this.currentUrl = landed.url;
    this.scrollPx = 0;
    this.settledUrls.delete(landed.url);
    if (landed.neverFinishesLoading === true) {
      this.cost(NEVER_FINISHES_LOAD_MS);
      // ⛔ A SUCCESS on a dead page. The harness resolves this as success with
      // `loadedAtTimeout: true` and the customer copy says "(page never finished
      // loading)" — so the executor counts it as a completed step. The scorer
      // must not.
      return { ok: true, output: { url: landed.url, loadedAtTimeout: true } };
    }
    this.cost(landed.loadMs);
    return { ok: true, output: { url: landed.url } };
  }

  private doClick(selector: string): DeviceOutcome {
    const element = this.findElement(selector);
    if (element === null) {
      this.cost(TRIVIAL_MS);
      return {
        ok: false,
        errorCode: 'intent_element_not_found',
        message: `no element matched ${selector}`,
      };
    }
    if (element.blockedBy !== undefined && !this.dismissed.has(element.blockedBy)) {
      this.cost(CLICK_MS);
      // The element IS there. It is intercepted. Keeping this distinct from
      // "not found" is the whole point of F1: one is retryable page state, the
      // other is an outcome-unknown browser command the executor must not replay.
      return {
        ok: false,
        errorCode: 'intent_webdriver_failed',
        message: 'element click intercepted',
      };
    }
    this.cost(CLICK_MS);
    this.applyClick(element);
    return { ok: true, output: { clicked: selector, behavioral: true, activated: true } };
  }

  private applyClick(element: ScriptedElement): void {
    const effect = element.onClick;
    if (effect === undefined) return;
    if (effect.dismiss !== undefined) this.dismissed.add(effect.dismiss);
    for (const revealed of effect.reveal ?? []) this.revealed.add(revealed);
    if (effect.setState !== undefined) this.flagsSet.add(effect.setState);
    if (effect.navigateTo !== undefined) {
      const landed = this.resolve(effect.navigateTo);
      this.currentUrl = landed.url;
      this.scrollPx = 0;
      this.settledUrls.delete(landed.url);
      this.cost(landed.loadMs);
    }
  }

  private doSendKeys(selector: string, text: string): DeviceOutcome {
    const element = this.findElement(selector);
    if (element === null) {
      this.cost(TRIVIAL_MS);
      return {
        ok: false,
        errorCode: 'intent_element_not_found',
        message: `no element matched ${selector}`,
      };
    }
    if (element.blockedBy !== undefined && !this.dismissed.has(element.blockedBy)) {
      this.cost(TRIVIAL_MS);
      return {
        ok: false,
        errorCode: 'intent_webdriver_failed',
        message: 'element click intercepted',
      };
    }
    this.cost(TRIVIAL_MS + text.length * TYPE_MS_PER_CHAR);
    this.typed.set(selector, text);
    for (const revealed of element.onType?.reveal ?? []) this.revealed.add(revealed);
    return {
      ok: true,
      output: { typed_into: selector, length: text.length, truncated: false, behavioral: true },
    };
  }

  private doPressKey(key: string): DeviceOutcome {
    if (!RESOLVABLE_KEYS.has(key)) {
      this.cost(TRIVIAL_MS);
      return {
        ok: false,
        errorCode: 'intent_invalid_parameter',
        message: `key "${key}" does not resolve`,
      };
    }
    this.cost(TRIVIAL_MS);
    if (key === 'Enter') {
      const onEnter = this.page().onEnter;
      if (onEnter !== undefined) {
        for (const revealed of onEnter.reveal ?? []) this.revealed.add(revealed);
        if (onEnter.navigateTo !== undefined) {
          const landed = this.resolve(onEnter.navigateTo);
          this.currentUrl = landed.url;
          this.scrollPx = 0;
          this.settledUrls.delete(landed.url);
          this.cost(landed.loadMs);
        }
      }
    }
    return { ok: true, output: { pressed: key } };
  }

  private doWaitFor(params: Record<string, unknown>): DeviceOutcome {
    const predicate = readString(params, 'predicate');
    const timeoutSeconds =
      typeof params.timeout_seconds === 'number'
        ? params.timeout_seconds
        : HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS;
    const budgetMs = timeoutSeconds * 1000;
    const classified = classifyWaitPredicate(predicate);
    if (classified.kind === 'idle') {
      const page = this.page();
      if (page.neverFinishesLoading === true) {
        this.cost(budgetMs);
        return {
          ok: false,
          errorCode: 'intent_webdriver_failed',
          message: 'the document never reached a quiet state',
        };
      }
      if (this.settledUrls.has(page.url)) {
        this.cost(TRIVIAL_MS);
        return { ok: true, output: { waited: true, timeout_capped: false } };
      }
      if (page.settleMs > budgetMs) {
        this.cost(budgetMs);
        return {
          ok: false,
          errorCode: 'intent_webdriver_failed',
          message: 'the document never reached a quiet state',
        };
      }
      this.cost(page.settleMs);
      this.settledUrls.add(page.url);
      return { ok: true, output: { waited: true, timeout_capped: false } };
    }
    const element = this.findScripted(classified.selector);
    if (element === null) {
      this.cost(budgetMs);
      return {
        ok: false,
        errorCode: 'intent_webdriver_failed',
        message: `${classified.selector} ${NEVER_BECAME_VISIBLE}`,
      };
    }
    const appearsAt = element.appearsAfterMs ?? 0;
    const scrollGate = element.appearsAfterScrollPx ?? 0;
    const revealGate = element.revealedBy;
    const reachable =
      this.scrollPx >= scrollGate &&
      (revealGate === undefined || this.revealed.has(revealGate)) &&
      appearsAt <= this.clock.now() + budgetMs;
    if (!reachable) {
      this.cost(budgetMs);
      return {
        ok: false,
        errorCode: 'intent_webdriver_failed',
        message: `${classified.selector} ${NEVER_BECAME_VISIBLE}`,
      };
    }
    this.cost(Math.max(TRIVIAL_MS, appearsAt - this.clock.now()));
    return { ok: true, output: { waited: true, timeout_capped: false } };
  }

  private doGetPageSource(): DeviceOutcome {
    this.cost(TRIVIAL_MS);
    const source = this.page().bodyText(this.stateView());
    if (source.length > this.pageSourceMaxChars) {
      return {
        ok: false,
        errorCode: 'result_too_large',
        message: 'the inline result exceeded the cap',
      };
    }
    return { ok: true, output: { source, truncated: false } };
  }

  private doScroll(params: Record<string, unknown>): DeviceOutcome {
    const direction = params.direction === 'up' ? 'up' : 'down';
    const requested = typeof params.distance_px === 'number' ? params.distance_px : 600;
    const before = this.scrollPx;
    const next = direction === 'up' ? before - requested : before + requested;
    this.scrollPx = Math.max(0, next);
    this.cost(SCROLL_MS);
    return {
      ok: true,
      output: {
        scrolled: this.scrollPx - before,
        requested: direction === 'up' ? -requested : requested,
        scrolled_measured: true,
        flicks: 1,
        steps: 2,
        behavioral: true,
        distance_capped: false,
      },
    };
  }

  private doBehavioralPause(params: Record<string, unknown>): DeviceOutcome {
    const pausedMs =
      params.kind === 'reading' && typeof params.word_count === 'number'
        ? params.word_count * READING_MS_PER_WORD
        : typeof params.duration_ms === 'number'
          ? params.duration_ms
          : DEFAULT_PAUSE_MS;
    this.cost(pausedMs);
    return { ok: true, output: { paused_ms: pausedMs, capped: false, behavioral: true } };
  }

  // ── state helpers ───────────────────────────────────────────────────

  private cost(ms: number): void {
    this.clock.advance(ms);
  }

  private page(): ScriptedPage {
    return this.resolve(this.currentUrl);
  }

  private resolve(url: string): ScriptedPage {
    return this.sites.get(url) ?? this.sites.get(stripTrailingSlash(url)) ?? notFoundPage(url);
  }

  private findScripted(selector: string): ScriptedElement | null {
    return this.page().elements.find((e) => e.selector === selector) ?? null;
  }

  /** The element as the browser would find it NOW — availability rules applied. */
  private findElement(selector: string): ScriptedElement | null {
    const element = this.findScripted(selector);
    if (element === null) return null;
    if (element.revealedBy !== undefined && !this.revealed.has(element.revealedBy)) return null;
    if ((element.appearsAfterMs ?? 0) > this.clock.now()) return null;
    if ((element.appearsAfterScrollPx ?? 0) > this.scrollPx) return null;
    return element;
  }

  /**
   * Structured extraction, honouring the same availability rules a click does:
   * a named field whose element is not present yet reads as null rather than as
   * an absent key, so a caller can tell "not there" from "not asked for".
   */
  private doExtract(params: Record<string, unknown>): DeviceOutcome {
    this.cost(TRIVIAL_MS);
    const requested = Array.isArray(params.extractions) ? params.extractions : [];
    const value: Record<string, unknown> = {};
    for (const entry of requested) {
      if (typeof entry !== 'object' || entry === null) continue;
      const spec = entry as { name?: unknown; selector?: unknown };
      if (typeof spec.name !== 'string' || typeof spec.selector !== 'string') continue;
      const element = this.findElement(spec.selector);
      value[spec.name] = element?.text ?? null;
    }
    return { ok: true, output: { value } };
  }

  private stateView() {
    return {
      currentUrl: this.currentUrl,
      elapsedMs: this.clock.now(),
      scrollPx: this.scrollPx,
      dismissed: this.dismissed,
      revealed: this.revealed,
      typed: this.typed,
      flags: this.flagsSet,
    };
  }
}

type DeviceOutcome =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; errorCode: HarnessErrorCode; message?: string };

/**
 * Read a decoded wire param as a string.
 *
 * Never `String(value)`: params arrive from a base64 JSON decode, so a wrong
 * shape is possible, and stringifying an object would hand the device
 * "[object Object]" as a url or selector — a confident value for an input that
 * was never valid.
 */
function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : `${url}/`;
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match?.[1] ?? url;
}
