// The fake device: a DOM per page, driven through the real wire contract.
//
// ⛔ IT IS INJECTED AT `IntentDispatcher`, NOT AT `AgentExecutor`. A fake
// executor would bypass every layer that actually breaks — the verb→harness
// mapping and its CSS-selector refusal, the wire envelope, the result→customer
// mapping and its diagnosis table, the retry/no-retry fences, the `wait`
// exemption and the consequential-action gate. Those layers ARE the subject.
//
// ⛔ SELECTORS RESOLVE WITH `querySelector` SEMANTICS, NOT BY STRING EQUALITY.
// The first version of this device compared the planned selector to a
// hand-listed string, which is sound only while we author both sides. A live
// model writes whatever valid CSS it likes, and an exact-match device would fail
// every such plan for a reason that is not a fact about the agent. The page is
// parsed HTML now (see `dom.ts`), `get_page_source` serialises that same
// document, and first-match-in-document-order is what WebDriver does too.
//
// HONESTY MECHANISM (non-negotiable): the device never hand-constructs a
// `ParsedIntentResult`. It builds a real wire envelope with `encodeWireData` and
// returns `parseIntentResult(frame, intentName)`, which validates the payload
// against `HARNESS_INTENT_RESULT_SCHEMAS`. A device whose fiction drifts from
// the contract therefore fails loudly instead of feeding the agent loop a shape
// the real box never sends.

import type { DomDocument, DomElement } from 'jsdom';
import type { IntentDispatcher } from '../../../src/services/agent-executor-control-plane.js';
import { ELEMENT_NOT_INTERACTABLE, NEVER_BECAME_VISIBLE } from './score.js';
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
  InvalidSelectorError,
  PageDom,
  describeElement,
  documentHtml,
  isInteractable,
  isRendered,
  queryFirst,
  visibleTextOf,
} from './dom.js';
import {
  notFoundPage,
  type FixturePage,
  type FormBehaviour,
  type NotFoundBehaviour,
  type PageEffect,
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
/**
 * perceive for ONE selector, as A3 describes it: the native find (which on the
 * real device always fails fast), then the script resolver click falls back to,
 * then one hit test. Two instantaneous device operations, each costed like any
 * other here. This is the MODELLED per-tap cost of the look before a tap; the
 * real one is what the look's round-trip histogram measures in production.
 */
export const PERCEIVE_BY_SELECTOR_MS = 2 * TRIVIAL_MS;
/** A3's cap on the label perceive returns. */
const PERCEIVE_LABEL_MAX_CHARS = 200;
/** How long the harness spends before giving up on a page that never loads. */
const NEVER_FINISHES_LOAD_MS = 30_000;
/** Reading pace used to cost a `behavioral_pause{kind:'reading'}`. */
const READING_MS_PER_WORD = 240;
const DEFAULT_PAUSE_MS = 1_500;

/** `<input>` types that Enter ACTIVATES, as a click would, rather than using
 *  to submit the form implicitly. */
const ENTER_ACTIVATES_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'submit',
  'reset',
  'image',
]);

/** `<input>` types a keystroke cannot go into. */
const UNTYPABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

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
  /** For a `perceive` for one selector: what the device answered about a tap
   *  there — device-side truth a scorer may read, since a tap the look refused
   *  leaves no failed click in this log. */
  tapLook?:
    | 'nothing_resolved'
    | 'covered'
    | 'clear'
    | 'outside_viewport'
    | 'nothing_hit'
    | 'listing';
  urlBefore: string;
  urlAfter: string;
}

/**
 * What actually happened ON THE DEVICE, as opposed to what was asked of it.
 *
 * ⛔ A TYPED VALUE IS NEVER IN HERE. The log is copied into reports, and a
 * keystroke may be a customer's password. It records that something was typed,
 * where, and how long it was — which is everything a reader needs and nothing a
 * report must not hold. The values themselves stay on the device
 * ({@link FakeDevice.submissions}), which is where a real secret lives too.
 */
export type DeviceEvent =
  | {
      kind: 'navigated';
      via: 'navigate' | 'link' | 'form' | 'page';
      url: string;
      httpStatus?: number;
    }
  /** `id` is the clicked element's own id ('' when it has none) — what a safety
   *  criterion keys on, because the PLANNED selector can be anything. */
  | { kind: 'clicked'; selector: string; element: string; id: string }
  | { kind: 'typed'; selector: string; element: string; field: string | null; length: number }
  | { kind: 'submitted'; form: string; accepted: boolean; fields: string[] };

/** One form submission, values included. Device-side truth; never reported. */
export interface FormSubmission {
  url: string;
  form: string;
  accepted: boolean;
  values: Readonly<Record<string, string>>;
}

export interface FakeDeviceOptions {
  sites: SiteMap;
  startUrl: string;
  clock: VirtualClock;
  /** Inline result cap, mirroring the harness's own. Over-cap `get_page_source`
   *  fails with `result_too_large` rather than returning a truncated DOM. */
  pageSourceMaxChars?: number;
  /** Hosts the device's session is ALREADY signed in to. A successful login on
   *  a fixture site adds to this for the rest of the device's life. */
  authenticatedHosts?: ReadonlySet<string>;
  /** How these sites answer for an address they do not have. */
  notFound?: NotFoundBehaviour;
  /** A device from before perceive-by-selector (A3 2026-09-18): it ignores
   *  `selector` and answers with its page listing, carrying none of the new
   *  fields — the older device the look before a tap must fall back on. */
  predatesTapLook?: boolean;
}

/** The fixture asked the device to do something its page cannot support. A bug
 *  in the FIXTURE, never a finding about the agent — so it is loud. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
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

/** A selector lookup that ended somewhere other than "here is the element". */
type Lookup =
  | { ok: true; element: DomElement }
  | { ok: false; outcome: Extract<DeviceOutcome, { ok: false }>; costMs: number };

export class FakeDevice {
  private readonly sites: SiteMap;
  private readonly clock: VirtualClock;
  private readonly pageSourceMaxChars: number;
  private readonly authenticatedHosts: Set<string>;
  private readonly notFound: NotFoundBehaviour;
  private readonly predatesTapLook: boolean;

  private currentUrl: string;
  private currentPage: FixturePage;
  private dom: PageDom;
  /** Virtual time at which the navigation that produced this page STARTED. */
  private pageEpochMs = 0;
  private scrollPx = 0;
  private readonly appliedLateRenders = new Set<number>();
  private readonly appliedScrollRenders = new Set<number>();
  private focused: DomElement | null = null;
  /** What has been typed into each field of THIS page. A typed value is a
   *  property, never an attribute, so it is not in the serialised source. */
  private readonly typedValues = new Map<DomElement, string>();
  private readonly flagsSet = new Set<string>();
  private readonly settledUrls = new Set<string>();
  private readonly records: DispatchRecord[] = [];
  private readonly eventLog: DeviceEvent[] = [];
  private readonly submissionLog: FormSubmission[] = [];
  private deviceMsTotal = 0;

  constructor(opts: FakeDeviceOptions) {
    this.sites = opts.sites;
    this.clock = opts.clock;
    this.pageSourceMaxChars = opts.pageSourceMaxChars ?? 8 * 1024 * 1024;
    this.authenticatedHosts = new Set(opts.authenticatedHosts ?? []);
    this.notFound = opts.notFound ?? {};
    this.predatesTapLook = opts.predatesTapLook === true;
    this.currentUrl = opts.startUrl;
    // A device that starts ON a fixture page shows that page; one that starts
    // anywhere else (about:blank) shows an empty document.
    const start = this.lookup(opts.startUrl);
    this.currentPage = start ?? { url: opts.startUrl, title: '', body: '', loadMs: 0, settleMs: 0 };
    this.dom = new PageDom(documentHtml(this.currentPage), this.currentPage.url);
    this.pageEpochMs = this.clock.now();
    this.applyWhenFlag();
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

  /** What happened on the device, in order. Carries no typed value. */
  events(): ReadonlyArray<DeviceEvent> {
    return this.eventLog;
  }

  /** Every form submission, WITH its values. Device-side truth for a criterion
   *  to read; ⛔ never copy this into a report. */
  submissions(): ReadonlyArray<FormSubmission> {
    return this.submissionLog;
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

  /** The words on the page right now, as a person would read them. */
  visibleText(): string {
    this.sync();
    return visibleTextOf(this.dom.serialize());
  }

  // ── dispatch ────────────────────────────────────────────────────────

  private handle(dispatch: IntentDispatch): ParsedIntentResult {
    const params = decodeWireData(dispatch.inputParams) as Record<string, unknown>;
    const urlBefore = this.currentUrl;
    const before = this.clock.now();
    // Whatever the page was going to render by now, it has rendered — the
    // executor's own sleeps advance the same clock between dispatches.
    this.sync();
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
      ...(dispatch.intentName === 'perceive' && outcome.ok
        ? { tapLook: tapLookOf(outcome.output) }
        : {}),
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
      case 'perceive':
        return this.doPerceive(params);
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
    const landed = this.land(target, 'navigate');
    if (landed.neverFinishesLoading === true) {
      this.cost(NEVER_FINISHES_LOAD_MS);
      // ⛔ A SUCCESS on a dead page. The harness resolves this as success with
      // `loadedAtTimeout: true` and the customer copy says "(page never finished
      // loading)" — so the executor counts it as a completed step. The scorer
      // must not.
      return { ok: true, output: { url: landed.url, loadedAtTimeout: true } };
    }
    this.cost(landed.loadMs);
    return {
      ok: true,
      output: {
        url: landed.url,
        // Present only when the site says so: an absent status is "no opinion",
        // which is what keeps an older device's behaviour unchanged.
        ...(landed.httpStatus !== undefined ? { http_status: landed.httpStatus } : {}),
      },
    };
  }

  private doClick(selector: string): DeviceOutcome {
    const found = this.locate(selector, CLICK_MS);
    if (!found.ok) {
      this.cost(found.costMs);
      return found.outcome;
    }
    this.cost(CLICK_MS);
    this.activate(found.element, selector);
    return { ok: true, output: { clicked: selector, behavioral: true, activated: true } };
  }

  /** What a click DOES once it has landed on `element` — shared with the Enter
   *  key, which activates a focused button or link exactly as a click does. */
  private activate(element: DomElement, selector: string): void {
    this.focused = element;
    this.eventLog.push({
      kind: 'clicked',
      selector,
      element: describeElement(element),
      id: element.id,
    });
    let defaultPrevented = false;
    let navigated = false;
    for (const behaviour of this.currentPage.onClick ?? []) {
      if (this.closest(element, behaviour.target) === null) continue;
      if (behaviour.preventDefault === true) defaultPrevented = true;
      if (this.applyEffects(behaviour.effects, null, 'page')) navigated = true;
    }
    if (!defaultPrevented && !navigated) this.defaultClickAction(element);
  }

  /** What the browser does with a click nothing handled: follow the link, or
   *  submit the form the button belongs to. */
  private defaultClickAction(element: DomElement): void {
    const anchor = this.closest(element, 'a[href]');
    if (anchor !== null) {
      const href = anchor.getAttribute('href') ?? '';
      if (href.length === 0 || href.startsWith('#') || /^javascript:/i.test(href)) return;
      this.land(this.resolve(this.absolute(href)), 'link', true);
      return;
    }
    const submitter = this.closest(element, 'button, input[type="submit"], input[type="image"]');
    if (submitter === null) return;
    // A `<button>` with no type IS a submit button; only an explicit
    // `type="button"` / `type="reset"` opts out.
    const type = (submitter.getAttribute('type') ?? 'submit').toLowerCase();
    if (submitter.tagName === 'BUTTON' && type !== 'submit') return;
    const form = this.closest(submitter, 'form');
    if (form !== null) this.submitForm(form);
  }

  private doSendKeys(selector: string, text: string): DeviceOutcome {
    const found = this.locate(selector, TRIVIAL_MS);
    if (!found.ok) {
      this.cost(found.costMs);
      return found.outcome;
    }
    const element = found.element;
    if (!isTypable(element)) {
      this.cost(TRIVIAL_MS);
      return {
        ok: false,
        errorCode: 'intent_webdriver_failed',
        message: `${ELEMENT_NOT_INTERACTABLE}: keys cannot be sent to a <${element.tagName.toLowerCase()}>`,
      };
    }
    this.cost(TRIVIAL_MS + text.length * TYPE_MS_PER_CHAR);
    // WebDriver's send-keys APPENDS to what the field already holds. A plan that
    // types into the same field twice gets both, exactly as it would for real.
    this.typedValues.set(element, (this.typedValues.get(element) ?? '') + text);
    this.focused = element;
    this.eventLog.push({
      kind: 'typed',
      selector,
      element: describeElement(element),
      field: element.getAttribute('name'),
      length: text.length,
    });
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
    if (key === 'Enter') this.pressEnter();
    return { ok: true, output: { pressed: key } };
  }

  /**
   * What Enter does depends on WHERE THE FOCUS IS, and the device must not be
   * kinder than a browser about it.
   *
   * ⛔ "ENTER SUBMITS THE FOCUSED ELEMENT'S FORM" FLATTERED THE AGENT. In a
   * `<textarea>` Enter is a newline and submits nothing — so a plan that typed a
   * message and pressed Enter, which would leave a customer's form unsent, was
   * scored as a sent form. With nothing focused the key goes to the document
   * and nothing happens, which is what a plan that presses Enter without typing
   * anywhere first gets for real.
   */
  private pressEnter(): void {
    const focused = this.focused;
    if (focused === null || !this.dom.document.documentElement.contains(focused)) return;
    if (focused.tagName === 'TEXTAREA') {
      this.typedValues.set(focused, `${this.typedValues.get(focused) ?? ''}\n`);
      return;
    }
    const type = (focused.getAttribute('type') ?? '').toLowerCase();
    const isButtonLike =
      focused.tagName === 'BUTTON' ||
      focused.tagName === 'A' ||
      (focused.tagName === 'INPUT' && ENTER_ACTIVATES_INPUT_TYPES.has(type));
    if (isButtonLike) {
      // Enter on a focused button or link is a click on it.
      this.activate(focused, 'the focused element (Enter key)');
      return;
    }
    if (focused.tagName !== 'INPUT') return;
    // IMPLICIT SUBMISSION, as HTML defines it: the form submits if it has a
    // submit button, or if this is its only field that blocks implicit
    // submission. A multi-field form with no submit button does nothing.
    const form = this.closest(focused, 'form');
    if (form === null) return;
    const hasSubmitButton = Array.from(
      form.querySelectorAll('button, input[type="submit"], input[type="image"]'),
    ).some((candidate) => {
      if (candidate.tagName !== 'BUTTON') return true;
      return (candidate.getAttribute('type') ?? 'submit').toLowerCase() === 'submit';
    });
    const textLikeFields = Array.from(form.querySelectorAll('input')).filter(
      (field) => !UNTYPABLE_INPUT_TYPES.has((field.getAttribute('type') ?? 'text').toLowerCase()),
    );
    if (hasSubmitButton || textLikeFields.length === 1) this.submitForm(form);
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
      const page = this.currentPage;
      if (page.neverFinishesLoading === true || page.neverSettles === true) {
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
    return this.waitForVisible(classified.selector, budgetMs);
  }

  /**
   * Wait until `selector` resolves to a rendered element, or the budget ends.
   *
   * The only thing that can change the page while the device waits is a late
   * render, so the wait walks the pending ones in time order: it costs exactly
   * as long as the element took to appear, and the whole budget when nothing
   * the page will ever render matches.
   */
  private waitForVisible(selector: string, budgetMs: number): DeviceOutcome {
    const deadline = this.clock.now() + budgetMs;
    const startedAt = this.clock.now();
    for (;;) {
      let visible: boolean;
      try {
        const element = queryFirst(this.dom.document, selector);
        visible = element !== null && isRendered(element);
      } catch (err) {
        if (!(err instanceof InvalidSelectorError)) throw err;
        this.cost(TRIVIAL_MS);
        return { ok: false, errorCode: 'intent_invalid_parameter', message: err.message };
      }
      if (visible) {
        // Never free: a wait that found its element at once still cost a lookup.
        const spent = this.clock.now() - startedAt;
        if (spent < TRIVIAL_MS) this.cost(TRIVIAL_MS - spent);
        return { ok: true, output: { waited: true, timeout_capped: false } };
      }
      const nextRenderAt = this.nextLateRenderAt();
      if (nextRenderAt === null || nextRenderAt > deadline) {
        this.cost(deadline - this.clock.now());
        this.sync();
        return {
          ok: false,
          errorCode: 'intent_webdriver_failed',
          message: `${selector} ${NEVER_BECAME_VISIBLE}`,
        };
      }
      this.cost(nextRenderAt - this.clock.now());
      this.sync();
    }
  }

  /**
   * perceive for ONE selector (A3 2026-09-18) — what a tap on it would land on.
   *
   * ⛔ RESOLVED EXACTLY AS `click` RESOLVES IT: the same `queryFirst`, the same
   * "cannot parse" answer. An element the click would find is the element this
   * describes, so the look and the tap can never disagree about which element a
   * selector means.
   *
   * ⛔ THE HIT TEST IS THE FIXTURE'S OWN DECLARATION. There is no layout here,
   * so "what is under the tap point" is read off what the page already declares:
   * a rendered `overlays` entry that does not contain the element is on top of
   * it (the same rule that makes the click come back intercepted), and
   * `offViewport` / `nothingAtTapPoint` say where the tap point is off-screen or
   * over nothing. An element that is not rendered has an empty rect, so its tap
   * point is the page's origin and the hit test finds the page, as on a real
   * device. Read-only and deterministic: nothing here changes the page.
   *
   * perceive WITHOUT a selector — the page listing — is not modelled: nothing in
   * the product sends it, so a request for it means the mapper gained a caller
   * this corpus has never measured, and that must be loud.
   */
  private doPerceive(params: Record<string, unknown>): DeviceOutcome {
    const selector = params.selector;
    if (typeof selector !== 'string') {
      throw new Error(
        'fake device models perceive only for one selector — a page-listing perceive reached it',
      );
    }
    if (params.strategy !== undefined && params.strategy !== 'css') {
      throw new Error(
        `fake device models perceive only with css selectors, got ${JSON.stringify(params.strategy)}`,
      );
    }
    this.cost(PERCEIVE_BY_SELECTOR_MS);
    if (this.predatesTapLook) {
      return this.perceivePageListing(
        typeof params.max_elements === 'number' ? params.max_elements : 200,
      );
    }
    let element: DomElement | null;
    try {
      element = queryFirst(this.dom.document, selector);
    } catch (err) {
      if (!(err instanceof InvalidSelectorError)) throw err;
      return { ok: false, errorCode: 'intent_invalid_parameter', message: err.message };
    }
    const value = {
      url: this.currentUrl,
      title: this.dom.document.title,
      truncated: false,
      resolved_by: 'script',
    };
    if (element === null) {
      return { ok: true, output: { value: { ...value, elements: [], total_matched: 0 } } };
    }
    const rendered = isRendered(element);
    const bounds = rendered ? this.boundsOf(element) : { x: 0, y: 0, width: 0, height: 0 };
    const tapPoint = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    };
    let hit: DomElement | null;
    let occlusionReason: string | null;
    if (!rendered) {
      hit = this.dom.document.body;
      occlusionReason = 'hit_is_not_target_or_descendant';
    } else if (this.declares(this.currentPage.offViewport, element)) {
      hit = null;
      occlusionReason = 'tap_point_outside_viewport';
    } else if (this.declares(this.currentPage.nothingAtTapPoint, element)) {
      hit = null;
      occlusionReason = 'nothing_hit';
    } else {
      const cover = this.coveringOverlay(element);
      hit = cover ?? element;
      occlusionReason = cover !== null ? 'hit_is_not_target_or_descendant' : null;
    }
    return {
      ok: true,
      output: {
        value: {
          ...value,
          elements: [
            {
              id: 0,
              type: perceiveTypeOf(element),
              label: perceiveLabelOf(element, this.dom.document),
              selector: canonicalSelectorOf(element),
              bounds,
              state: {
                visible: rendered,
                enabled: !element.hasAttribute('disabled'),
                focused: this.focused === element,
              },
              position_summary: rendered ? 'in view' : 'not rendered',
              tap_point: tapPoint,
              hit:
                hit === null
                  ? null
                  : {
                      type: perceiveTypeOf(hit),
                      label: perceiveLabelOf(hit, this.dom.document),
                      selector: canonicalSelectorOf(hit),
                      bounds: this.boundsOf(hit),
                    },
              occluded: occlusionReason !== null,
              occlusion_reason: occlusionReason,
            },
          ],
          total_matched: 1,
        },
      },
    };
  }

  /** An older device's perceive: the selector is ignored and the rendered
   *  controls are listed — capped by `max_elements`, which it does honour —
   *  with no `resolved_by` and none of the new fields. */
  private perceivePageListing(maxElements: number): DeviceOutcome {
    const controls = Array.from(
      this.dom.document.querySelectorAll('a, button, input, select, textarea'),
    ).filter((element) => isRendered(element));
    const listed = controls.slice(0, Math.max(1, Math.min(200, maxElements)));
    return {
      ok: true,
      output: {
        value: {
          url: this.currentUrl,
          title: this.dom.document.title,
          elements: listed.map((element, index) => ({
            id: index,
            type: perceiveTypeOf(element),
            label: perceiveLabelOf(element, this.dom.document),
            selector: canonicalSelectorOf(element),
            bounds: this.boundsOf(element),
            state: {
              visible: true,
              enabled: !element.hasAttribute('disabled'),
              focused: this.focused === element,
            },
            position_summary: 'in view',
          })),
          truncated: controls.length > listed.length,
          total_matched: controls.length,
        },
      },
    };
  }

  /** No layout, so a rect is a deterministic function of document order: every
   *  element its own 32px row. Only its SHAPE is load-bearing (a rendered
   *  element has a non-empty rect); nothing reads the numbers as geometry. */
  private boundsOf(element: DomElement): { x: number; y: number; width: number; height: number } {
    const all = Array.from(this.dom.document.querySelectorAll('*'));
    const index = Math.max(0, all.indexOf(element));
    return { x: 16, y: index * 32, width: 320, height: 32 };
  }

  /** Does the page declare `element` in this (fixture-authored) selector list? */
  private declares(list: ReadonlyArray<string> | undefined, element: DomElement): boolean {
    for (const selector of list ?? []) {
      let matches: boolean;
      try {
        matches = element.matches(selector);
      } catch {
        throw new FixtureError(
          `${this.currentPage.url} declares an unparsable selector: ${selector}`,
        );
      }
      if (matches) return true;
    }
    return false;
  }

  private doGetPageSource(): DeviceOutcome {
    this.cost(TRIVIAL_MS);
    const source = this.dom.serialize();
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
    // A region that renders on scroll renders now, and STAYS rendered: scrolling
    // back up does not take a lazily-loaded section out of the document.
    this.sync();
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
    this.sync();
    return { ok: true, output: { paused_ms: pausedMs, capped: false, behavioral: true } };
  }

  /**
   * Structured extraction, honouring the same availability rules a click does:
   * a named field whose element is not rendered yet reads as null rather than as
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
      let element: DomElement | null = null;
      try {
        element = queryFirst(this.dom.document, spec.selector);
      } catch (err) {
        if (!(err instanceof InvalidSelectorError)) throw err;
      }
      value[spec.name] =
        element !== null && isRendered(element)
          ? (element.textContent ?? '').replace(/\s+/g, ' ').trim()
          : null;
    }
    return { ok: true, output: { value } };
  }

  // ── locating ────────────────────────────────────────────────────────

  /**
   * Resolve a selector to the element a gesture would land on, or say why not.
   *
   * ⛔ FOUR DIFFERENT NOs, KEPT DIFFERENT, because the executor handles each one
   * differently: a selector the engine cannot parse is a planning fault (never
   * replayed); no match is page state (waited for, then retried); a match that
   * is not rendered cannot be interacted with; and a match that is covered is an
   * outcome-unknown browser failure that must NOT be replayed.
   */
  private locate(selector: string, interceptedCostMs: number): Lookup {
    let element: DomElement | null;
    try {
      element = queryFirst(this.dom.document, selector);
    } catch (err) {
      if (!(err instanceof InvalidSelectorError)) throw err;
      return {
        ok: false,
        costMs: TRIVIAL_MS,
        outcome: { ok: false, errorCode: 'intent_invalid_parameter', message: err.message },
      };
    }
    if (element === null) {
      return {
        ok: false,
        costMs: TRIVIAL_MS,
        outcome: {
          ok: false,
          errorCode: 'intent_element_not_found',
          message: `no element matched ${selector}`,
        },
      };
    }
    if (!isInteractable(element)) {
      return {
        ok: false,
        costMs: TRIVIAL_MS,
        outcome: {
          ok: false,
          errorCode: 'intent_webdriver_failed',
          // First match in document order, as WebDriver resolves it. A hidden
          // copy of a link that ALSO exists in the footer is still the one a
          // loose selector lands on.
          message: `${ELEMENT_NOT_INTERACTABLE}: ${selector} matched ${describeElement(element)}, which is not rendered or is disabled`,
        },
      };
    }
    if (this.coveredByOverlay(element)) {
      // The element IS there. It is intercepted. Keeping this distinct from
      // "not found" is the whole point of F1: one is retryable page state, the
      // other is an outcome-unknown browser command the executor must not replay.
      return {
        ok: false,
        costMs: interceptedCostMs,
        outcome: {
          ok: false,
          errorCode: 'intent_webdriver_failed',
          message: 'element click intercepted',
        },
      };
    }
    return { ok: true, element };
  }

  private coveredByOverlay(element: DomElement): boolean {
    return this.coveringOverlay(element) !== null;
  }

  /** The declared overlay on top of `element`, or null — the ONE rule both the
   *  click's interception and perceive's hit test read. */
  private coveringOverlay(element: DomElement): DomElement | null {
    for (const overlaySelector of this.currentPage.overlays ?? []) {
      const overlay = queryFirst(this.dom.document, overlaySelector);
      if (overlay !== null && isRendered(overlay) && !overlay.contains(element)) return overlay;
    }
    return null;
  }

  /** `closest`, for a FIXTURE-authored selector: an unparsable one is a fixture
   *  bug, not a planning fault. */
  private closest(element: DomElement, selector: string): DomElement | null {
    try {
      return element.closest(selector);
    } catch {
      throw new FixtureError(
        `${this.currentPage.url} declares an unparsable selector: ${selector}`,
      );
    }
  }

  // ── forms ───────────────────────────────────────────────────────────

  private submitForm(form: DomElement): void {
    const behaviour = (this.currentPage.forms ?? []).find((candidate) => {
      try {
        return form.matches(candidate.form);
      } catch {
        throw new FixtureError(
          `${this.currentPage.url} declares an unparsable form selector: ${candidate.form}`,
        );
      }
    });
    if (behaviour === undefined) {
      // ⛔ NEVER A QUIET NO-OP. A submit that silently did nothing would read as
      // "the agent submitted and the site ignored it", which is a finding about
      // the agent invented by a hole in the fixture.
      throw new FixtureError(
        `${this.currentPage.url}: ${describeElement(form)} was submitted and the fixture declares no behaviour for it`,
      );
    }
    const values = this.formValues(form);
    const accepted = accepts(behaviour, values);
    this.submissionLog.push({
      url: this.currentUrl,
      form: describeElement(form),
      accepted,
      values,
    });
    this.eventLog.push({
      kind: 'submitted',
      form: describeElement(form),
      accepted,
      fields: Object.keys(values),
    });
    this.applyEffects(accepted ? behaviour.onAccepted : (behaviour.onRejected ?? []), form, 'form');
  }

  private formValues(form: DomElement): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of Array.from(form.querySelectorAll('input, textarea, select'))) {
      const name = field.getAttribute('name');
      if (name === null || name.length === 0) continue;
      values[name] = this.typedValues.get(field) ?? field.getAttribute('value') ?? '';
    }
    return values;
  }

  // ── page lifecycle ──────────────────────────────────────────────────

  /**
   * Put the device ON a page. Follows the login wall and a redirect, replaces
   * the document, and restarts everything that belongs to a page load.
   *
   * `costLoad` is for a navigation that happens INSIDE another gesture (a link,
   * a form): the gesture's own cost is already spent, the load is extra.
   */
  private land(
    target: FixturePage,
    via: Extract<DeviceEvent, { kind: 'navigated' }>['via'],
    costLoad = false,
  ): FixturePage {
    // ⛔ EVERY HOP IS RE-CHECKED. A redirect that lands on a page behind a login
    // wall must hit that wall: following one hop and stopping would walk a
    // signed-out device straight into an authenticated page, and a login task
    // would then pass without anyone logging in. Bounded, so a fixture that
    // redirects in a circle fails loudly instead of hanging the run.
    let landed = target;
    for (let hop = 0; ; hop += 1) {
      if (hop > 8) {
        throw new FixtureError(`${target.url} redirects in a loop (last stop ${landed.url})`);
      }
      if (landed.requiresAuth !== undefined && !this.authenticatedHosts.has(hostOf(landed.url))) {
        landed = this.resolve(landed.requiresAuth.loginUrl);
      } else if (landed.redirectsTo !== undefined) {
        landed = this.resolve(landed.redirectsTo);
      } else {
        break;
      }
    }
    // A load that errors has no document to land on; from inside a gesture the
    // honest rendering of that is the site's own error page.
    if (landed.loadFails === true) landed = notFoundPage(landed.url, this.notFound);
    this.dom.close();
    this.currentPage = landed;
    this.currentUrl = landed.url;
    this.dom = new PageDom(documentHtml(landed), landed.url);
    this.pageEpochMs = this.clock.now();
    this.scrollPx = 0;
    this.focused = null;
    this.typedValues.clear();
    this.appliedLateRenders.clear();
    this.appliedScrollRenders.clear();
    this.settledUrls.delete(landed.url);
    this.applyWhenFlag();
    this.eventLog.push({
      kind: 'navigated',
      via,
      url: landed.url,
      ...(landed.httpStatus !== undefined ? { httpStatus: landed.httpStatus } : {}),
    });
    if (costLoad) {
      this.cost(landed.neverFinishesLoading === true ? NEVER_FINISHES_LOAD_MS : landed.loadMs);
    }
    return landed;
  }

  private applyWhenFlag(): void {
    for (const rule of this.currentPage.whenFlag ?? []) {
      if (this.flagsSet.has(rule.flag)) this.applyEffects(rule.effects, null, 'page');
    }
  }

  /** Render whatever the page was due to render by now. */
  private sync(): void {
    const page = this.currentPage;
    const elapsed = this.clock.now() - this.pageEpochMs;
    (page.lateRenders ?? []).forEach((render, index) => {
      if (this.appliedLateRenders.has(index) || render.afterMs > elapsed) return;
      this.appliedLateRenders.add(index);
      this.applyEffects(render.effects, null, 'page');
    });
    (page.scrollRenders ?? []).forEach((render, index) => {
      if (this.appliedScrollRenders.has(index) || render.atScrollPx > this.scrollPx) return;
      this.appliedScrollRenders.add(index);
      this.applyEffects(render.effects, null, 'page');
    });
  }

  /** Absolute virtual time of the next late render still pending, or null. */
  private nextLateRenderAt(): number | null {
    let next: number | null = null;
    (this.currentPage.lateRenders ?? []).forEach((render, index) => {
      if (this.appliedLateRenders.has(index)) return;
      const at = this.pageEpochMs + render.afterMs;
      if (next === null || at < next) next = at;
    });
    return next;
  }

  /**
   * Apply declared effects, navigation LAST (it replaces the document the
   * others address). Returns whether the device went somewhere.
   */
  private applyEffects(
    effects: ReadonlyArray<PageEffect>,
    form: DomElement | null,
    via: Extract<DeviceEvent, { kind: 'navigated' }>['via'],
  ): boolean {
    let destination: string | null = null;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'remove':
          this.target(effect.target).remove();
          break;
        case 'insert':
          this.target(effect.into).insertAdjacentHTML('beforeend', effect.html);
          break;
        case 'set_attribute':
          this.target(effect.target).setAttribute(effect.name, effect.value);
          break;
        case 'remove_attribute':
          this.target(effect.target).removeAttribute(effect.name);
          break;
        case 'toggle_attribute': {
          const element = this.target(effect.target);
          if (element.hasAttribute(effect.name)) element.removeAttribute(effect.name);
          else element.setAttribute(effect.name, '');
          break;
        }
        case 'set_text':
          this.target(effect.target).textContent = effect.text;
          break;
        case 'set_flag':
          this.flagsSet.add(effect.flag);
          break;
        case 'authenticate':
          this.authenticatedHosts.add(effect.host);
          break;
        case 'navigate':
          destination = this.absolute(effect.url);
          break;
        case 'clear_fields': {
          if (form === null) {
            throw new FixtureError(
              `${this.currentPage.url} uses clear_fields outside a form behaviour`,
            );
          }
          for (const field of Array.from(form.querySelectorAll('input, textarea, select'))) {
            this.typedValues.delete(field);
          }
          break;
        }
        case 'submit_get': {
          if (form === null) {
            throw new FixtureError(
              `${this.currentPage.url} uses submit_get outside a form behaviour`,
            );
          }
          const url = new URL(this.absolute(form.getAttribute('action') ?? this.currentUrl));
          for (const [name, value] of Object.entries(this.formValues(form))) {
            url.searchParams.set(name, value);
          }
          destination = url.toString();
          break;
        }
        default: {
          // Exhaustiveness: an effect added to the page model must be applied
          // here rather than silently skipped, which would read as a page that
          // ignored the agent.
          const _exhaustive: never = effect;
          void _exhaustive;
        }
      }
    }
    if (destination === null) return false;
    this.land(this.resolve(destination), via, true);
    return true;
  }

  private target(selector: string): DomElement {
    let element: DomElement | null;
    try {
      element = queryFirst(this.dom.document, selector);
    } catch {
      throw new FixtureError(
        `${this.currentPage.url} declares an unparsable selector: ${selector}`,
      );
    }
    if (element === null) {
      throw new FixtureError(
        `${this.currentPage.url} declares an effect on ${selector}, which is not in the document`,
      );
    }
    return element;
  }

  // ── state helpers ───────────────────────────────────────────────────

  private cost(ms: number): void {
    this.clock.advance(ms);
  }

  private absolute(url: string): string {
    try {
      return new URL(url, isAbsoluteHttp(this.currentUrl) ? this.currentUrl : undefined).toString();
    } catch {
      return url;
    }
  }

  /**
   * ⛔ AN ADDRESS IS NOT A STRING. A customer says "gearfinder.test", and a model
   * is as likely to write `http://gearfinder.test/` or `https://www.…` as the
   * exact spelling a fixture author typed. A real site answers all of them (it
   * upgrades the scheme and drops the `www.`), and a device that 404'd them
   * would fail a plan at step one for a reason that is not a fact about the
   * agent — the same artefact exact-match SELECTORS were, one layer up. The
   * first live run measured exactly that: six of eleven tasks died on a valid
   * address. The page is keyed on the canonical https form; this finds it.
   */
  private lookup(url: string): FixturePage | undefined {
    for (const candidate of addressSpellings(url)) {
      const page = this.sites.get(candidate) ?? this.sites.get(toggleTrailingSlash(candidate));
      if (page !== undefined) return page;
    }
    return undefined;
  }

  /**
   * The page an address resolves to. Exact first; then the same address without
   * its query and fragment, where the page's own `queryRoutes` decide what a
   * query means; and the site's not-found page for everything else.
   */
  private resolve(url: string): FixturePage {
    const exact = this.lookup(url);
    if (exact !== undefined) return exact;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return notFoundPage(url, this.notFound);
    }
    // Looked up through the same canonicalisation as an exact address, so
    // `http://…/search?q=x` reaches the page `https://…/search` declares.
    const bare = `${parsed.origin}${parsed.pathname}`;
    const base = this.lookup(bare);
    if (base === undefined) return notFoundPage(url, this.notFound);
    if (base.queryRoutes === undefined || parsed.search.length === 0) return base;
    for (const rule of base.queryRoutes.rules) {
      const value = parsed.searchParams.get(rule.param);
      if (value !== null && rule.matches.test(value)) return this.resolve(rule.to);
    }
    return this.resolve(base.queryRoutes.otherwise);
  }
}

type DeviceOutcome =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; errorCode: HarnessErrorCode; message?: string };

function accepts(behaviour: FormBehaviour, values: Readonly<Record<string, string>>): boolean {
  for (const [name, rule] of Object.entries(behaviour.accepts ?? {})) {
    const value = values[name] ?? '';
    if (typeof rule === 'string' ? value !== rule : !rule.test(value)) return false;
  }
  return true;
}

function isTypable(element: DomElement): boolean {
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') {
    return !UNTYPABLE_INPUT_TYPES.has((element.getAttribute('type') ?? 'text').toLowerCase());
  }
  const editable = element.getAttribute('contenteditable');
  return editable !== null && editable.toLowerCase() !== 'false';
}

/**
 * Read a decoded wire param as a string.
 *
 * Never `String(value)`: params arrive from a base64 JSON decode, so a wrong
 * shape is possible, and stringifying an object would hand the device
 * "[object Object]" as a url or selector — a confident value for an input that
 * was never valid.
 */
/** What a perceive answer said about a tap, for the dispatch log. */
function tapLookOf(output: Record<string, unknown>): NonNullable<DispatchRecord['tapLook']> {
  const value = output.value as { resolved_by?: unknown; elements?: unknown } | undefined;
  if (value?.resolved_by === undefined) return 'listing';
  const elements = Array.isArray(value.elements) ? value.elements : [];
  const first = elements[0] as { occluded?: unknown; occlusion_reason?: unknown } | undefined;
  if (first === undefined) return 'nothing_resolved';
  if (first.occluded !== true) return 'clear';
  if (first.occlusion_reason === 'tap_point_outside_viewport') return 'outside_viewport';
  if (first.occlusion_reason === 'nothing_hit') return 'nothing_hit';
  return 'covered';
}

/** perceive's element `type` for an element. */
function perceiveTypeOf(element: DomElement): string {
  const tag = element.tagName;
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'SELECT') return 'select';
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'IMG') return 'image';
  if (tag === 'INPUT') {
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'input';
  }
  return 'other';
}

function collapsed(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The label A3's perceive-by-selector derives, in A3's order: aria-labelledby →
 * aria-label → `<label for>` / a wrapping `<label>` → alt → placeholder → value
 * (button inputs only) → text content → title; whitespace collapsed, at most 200
 * characters. Never a typed value: a text field's `value` is not in the order.
 */
function perceiveLabelOf(element: DomElement, document: DomDocument): string {
  const labelledBy = collapsed(element.getAttribute('aria-labelledby'));
  const fromIds = labelledBy
    .split(' ')
    .filter((id) => id.length > 0)
    .map((id) => {
      const target = /^[A-Za-z_][-\w]*$/.test(id) ? document.querySelector(`#${id}`) : null;
      return collapsed(target?.textContent ?? null);
    })
    .join(' ')
    .trim();
  const id = element.id;
  const forLabel =
    id.length > 0 && /^[A-Za-z_][-\w]*$/.test(id)
      ? document.querySelector(`label[for="${id}"]`)
      : null;
  const wrapping = element.closest('label');
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  const buttonValue =
    element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(type)
      ? element.getAttribute('value')
      : null;
  const candidates = [
    fromIds,
    collapsed(element.getAttribute('aria-label')),
    collapsed(forLabel?.textContent ?? null),
    collapsed(wrapping?.textContent ?? null),
    collapsed(element.getAttribute('alt')),
    collapsed(element.getAttribute('placeholder')),
    collapsed(buttonValue),
    element.tagName === 'TEXTAREA' || element.tagName === 'INPUT'
      ? ''
      : collapsed(element.textContent),
    collapsed(element.getAttribute('title')),
  ];
  return (candidates.find((c) => c.length > 0) ?? '').slice(0, PERCEIVE_LABEL_MAX_CHARS);
}

/**
 * The device's canonical selector — one spelling per element, whatever the
 * plan wrote: `#id` when it has a plain id, its test id next, and otherwise a
 * structural path of `tag:nth-of-type(n)` steps from the nearest ancestor with a
 * plain id (or from `html`). It resolves back to the same element, which is what
 * lets the click take it.
 */
function canonicalSelectorOf(element: DomElement): string {
  const plainId = (el: DomElement): string | null =>
    /^[A-Za-z_][-\w]*$/.test(el.id) ? `#${el.id}` : null;
  const own = plainId(element);
  if (own !== null) return own;
  const testId = element.getAttribute('data-testid');
  if (testId !== null && testId.length > 0 && !testId.includes('"')) {
    return `[data-testid="${testId}"]`;
  }
  const steps: string[] = [];
  let node: DomElement | null = element;
  while (node !== null) {
    const anchor = plainId(node);
    if (anchor !== null && node !== element) {
      steps.unshift(anchor);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: DomElement | null = node.parentElement;
    if (parent === null) {
      steps.unshift(tag);
      break;
    }
    const current: DomElement = node;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
    steps.unshift(`${tag}:nth-of-type(${String(sameTag.indexOf(current) + 1)})`);
    node = parent;
  }
  return steps.join(' > ');
}

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

/** The address as given, then as a real site would canonicalise it: https, and
 *  without a leading `www.`. Anything that is not an http(s) url is left alone. */
function addressSpellings(url: string): string[] {
  const match = /^(https?):\/\/(www\.)?(.*)$/i.exec(url);
  if (match === null) return [url];
  const rest = match[3] ?? '';
  return [...new Set([url, `https://${rest}`])];
}

function toggleTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : `${url}/`;
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match?.[1] ?? url;
}
