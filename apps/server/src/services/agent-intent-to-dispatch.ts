// Increment-2 (b) — pure mapping from the customer-facing AgentIntent
// vocabulary (api-types/agent-intents.ts) to the harness control-plane
// intentName + params (schemas/harness-control-protocol.ts).
//
// This is the reusable CORE the AgentExecutor v2 + the /v1/fleet/events
// intentDispatch sender will call: it turns one decomposer-emitted
// AgentIntent into the `{ intentName, params }` that goes into a
// ControlInbound.intentDispatch envelope. It is the CORRECT-LAYER
// replacement for the verb→driver translation in the (unwired,
// architecture-superseded) RealAgentExecutor — agent-session intents
// dispatch over the control-plane WSS by intentName, NOT the local driver
// (see the internal harness control-plane contract notes).
//
// Pure + transport-agnostic on purpose: it produces the params OBJECT and
// validates it against HARNESS_INTENT_PARAM_SCHEMAS, but does NOT serialise
// inputParams. So this mapping is stable regardless of how the envelope is encoded.
//
// ⛔ STALE (2026-08-26) — this said the Swift `Data` wire codec was "still pending
// harness confirmation". It was RESOLVED 2026-06-05, and the very header this line
// points at says so: "Wire codec (confirmed against the harness 2026-06-05): … cross the wire
// as a BASE64 STRING of the UTF-8 JSON". `harness-control-codec.ts` has implemented
// both directions since.
//
// ⚠️ Worth keeping as a caution: this sentence CITED its own refutation. A reader
// following the pointer lands on the resolution, so the cross-reference did not go
// stale — only the claim wrapped around it did, and a citation reads as freshness.
//
// Vocab reconciliation: the current AgentIntent union is narrower than the
// harness vocabulary, and a few verbs have no clean 1:1 target. Those map
// to a typed `unsupported` result (NOT a silent guess) so the executor
// surfaces an honest failure instead of dispatching wrong semantics. The
// richer customer intents (scroll direction/distance, back/forward,
// behavioral_pause) are Increment-2 (c) — additive, so the clean mappings
// here won't change when they land.

import type { AgentIntent } from '@driftstack/api-types';
import {
  HARNESS_INTENT_PARAM_SCHEMAS,
  type HarnessIntentName,
} from '../schemas/harness-control-protocol.js';
import { selectorImpliesSensitiveInput } from './agent-sensitive-input.js';
import { validateCssSelector } from './agent-selector-validation.js';

/**
 * R7 — the settle's own ceiling, measured from the navigation's `loadEventEnd`.
 * Past it the page is called settled however much it is still doing, so an
 * animated or live page cannot hold a plan open.
 */
export const SETTLE_CEILING_MS = 3_000;

/** R7 — how long the page must be quiet (no load, no resource completing, fonts
 *  loaded) before a settle says yes. */
export const SETTLE_QUIET_MS = 500;

/**
 * R7 — what a settle ASKS the device for, in whole seconds, so the device's own
 * 30s `HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS` is never what bounds it.
 *
 * The ceiling above plus a margin for the device round trip and its own poll
 * cadence. ⛔ IT IS A CEILING ON OUR PATIENCE, NOT A PROMISE ABOUT THE PAGE: a
 * settle that times out is non-fatal (the executor's `wait` exemption to
 * halt-on-first-failure), so the cost of being wrong here is a few seconds, and
 * the cost of omitting it was thirty.
 */
export const SETTLE_TIMEOUT_SECONDS = Math.ceil((SETTLE_CEILING_MS + 2_000) / 1000);

/**
 * R7 — how far past a page's `loadEventEnd` the ceiling above still describes
 * THIS wait.
 *
 * ⛔ IT EXISTS BECAUSE A STATELESS PREDICATE CANNOT KNOW WHEN ITS WAIT BEGAN.
 * The ceiling asks "have we been waiting three seconds", and the only instant a
 * stateless reader shares with the poll before it is the load event. For the
 * settle a navigate inserts they are the same instant; for a settle after a
 * same-document transition they are not, and an unbounded comparison would call
 * every such page settled on the first poll — the settle would stop settling
 * while still reporting success. So the ceiling is only claimed inside the span
 * a settle that began AT the load event could still be polling: the ceiling plus
 * the timeout every settle sends.
 */
export const SETTLE_CEILING_APPLIES_WITHIN_MS = SETTLE_CEILING_MS + SETTLE_TIMEOUT_SECONDS * 1000;

export type AgentIntentDispatch =
  | { ok: true; intentName: HarnessIntentName; params: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Map one customer AgentIntent to the harness `{ intentName, params }`.
 *
 * Clean 1:1 mappings (navigate / tap→click / type→send_keys /
 * scroll→scroll / wait:selector_visible→wait_for / screenshot /
 * dom_snapshot→get_page_source, wait:idle→wait_for[readyState==='complete'])
 * return `{ ok: true, ... }`. Verbs with no faithful harness target (swipe, pdf)
 * and intents missing a required field return `{ ok: false, reason }`.
 *
 * The produced params are validated against the canonical harness param
 * schema for the chosen intentName; a validation miss returns `ok:false`
 * rather than emitting a malformed dispatch.
 */
export function agentIntentToDispatch(intent: AgentIntent): AgentIntentDispatch {
  const mapped = mapIntent(intent);
  if (!mapped.ok) return mapped;

  const schema = HARNESS_INTENT_PARAM_SCHEMAS[mapped.intentName];
  const parsed = schema.safeParse(mapped.params);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `${mapped.intentName} params failed harness-contract validation: ${parsed.error.message}`,
    };
  }
  return mapped;
}

function mapIntent(intent: AgentIntent): AgentIntentDispatch {
  switch (intent.kind) {
    case 'navigate':
      return { ok: true, intentName: 'navigate', params: { url: intent.url } };

    case 'interact':
      return mapInteract(intent);

    case 'wait':
      return mapWait(intent);

    case 'capture':
      return mapCapture(intent);

    case 'scroll':
      // Explicit directional scroll → harness scroll{direction, distance_px}.
      // amount_px omitted → harness applies its 600px persona default.
      return {
        ok: true,
        intentName: 'scroll',
        params: {
          direction: intent.direction,
          ...(intent.amount_px !== undefined ? { distance_px: intent.amount_px } : {}),
        },
      };

    case 'behavioral_pause':
      // reading_word_count wins (→ persona-scaled reading pause); else duration_ms
      // (→ explicit pause); else neither → bare {} = harness persona idle pause.
      // W1223 — reading pauses always request scroll_through: the harness
      // segmentedReadingPlan traverses long content (read→scroll→read) instead of a
      // frozen multi-minute dwell (a tell), and degrades to a single in-place dwell
      // (byte-identical to the old behaviour) for content that fits the viewport — so
      // it's a strict tell-fix with no change to short reads.
      return {
        ok: true,
        intentName: 'behavioral_pause',
        params:
          intent.reading_word_count !== undefined
            ? { kind: 'reading', word_count: intent.reading_word_count, scroll_through: true }
            : intent.duration_ms !== undefined
              ? { duration_ms: intent.duration_ms }
              : {},
      };
  }
}

function mapInteract(intent: Extract<AgentIntent, { kind: 'interact' }>): AgentIntentDispatch {
  switch (intent.action) {
    case 'tap':
      if (intent.selector === undefined || intent.selector.length === 0) {
        return { ok: false, reason: 'interact:tap requires a selector' };
      }
      {
        // ⛔ Refuse a non-CSS locator HERE rather than letting WebDriver reject
        // it. Dispatching `button:has-text('Sign up')` produced an opaque HTTP
        // 500 with diagnosis "unknown"/not-retryable — measured live 2026-09-02
        // on the owner's own prompt. A named reason lets the agent correct
        // itself; a 500 tells it nothing.
        const verdict = validateCssSelector(intent.selector);
        if (!verdict.ok)
          return {
            ok: false,
            reason: `interact:tap ${verdict.reason ?? 'has an invalid selector'}`,
          };
      }
      // CSS selector is the only locator the AgentIntent carries today.
      // The harness routes `strategy` straight to W3C WebDriver, so we emit the
      // W3C rawValue 'css selector' (NOT a friendly 'css') — the API translates
      // friendly→W3C so the harness stays W3C-faithful (W115). When the
      // customer schema later exposes other locators, map them here too
      // (xpath→'xpath', link_text→'link text', …).
      return {
        ok: true,
        intentName: 'click',
        params: { strategy: 'css selector', value: intent.selector },
      };

    case 'type': {
      if (intent.selector === undefined || intent.selector.length === 0) {
        return { ok: false, reason: 'interact:type requires a selector' };
      }
      {
        const verdict = validateCssSelector(intent.selector);
        if (!verdict.ok)
          return {
            ok: false,
            reason: `interact:type ${verdict.reason ?? 'has an invalid selector'}`,
          };
      }
      if (intent.value === undefined) {
        return { ok: false, reason: 'interact:type requires a value (the text to type)' };
      }
      const sensitive = intent.sensitive === true || selectorImpliesSensitiveInput(intent.selector);
      return {
        ok: true,
        intentName: 'send_keys',
        params: {
          strategy: 'css selector',
          value: intent.selector,
          text: intent.value,
          // W1150 (W1149) — forwarded only when set: sensitive fields get
          // no visible typo-corrections harness-side (and are never logged).
          ...(sensitive
            ? { sensitive: true }
            : intent.sensitive === false
              ? { sensitive: false }
              : {}),
        },
      };
    }

    case 'scroll':
      // The current AgentIntent scroll carries no direction/distance, so we
      // emit a bare scroll and let the harness apply its persona defaults
      // (down / 600px). Increment-2 (c) adds direction + distance_px.
      return { ok: true, intentName: 'scroll', params: {} };

    case 'press':
      // W540/W1221 — the harness `press_key` handler is LIVE (W1221): one
      // genuine W3C key press (keyDown+keyUp) on the FOCUSED element, for submit
      // (Enter), focus traversal (Tab), dismiss (Escape), list nav (Arrow*). The
      // customer's interact:press carries the DOM KeyboardEvent.key name in
      // `value`. The harness validates the key resolves; an unmapped/over-long
      // key surfaces as intent_invalid_parameter in the result.
      if (intent.value === undefined || intent.value.length === 0) {
        return {
          ok: false,
          reason: 'interact:press requires a value (the key name, e.g. "Enter")',
        };
      }
      return { ok: true, intentName: 'press_key', params: { key: intent.value } };

    case 'swipe':
      // The harness has no swipe intent (touch swipe ≈ a scroll flick, but
      // the AgentIntent carries no direction/distance to translate). Don't
      // guess — surface an honest unsupported.
      return {
        ok: false,
        reason: 'interact:swipe has no harness intent (use scroll); pending vocab reconciliation',
      };
  }
}

function mapWait(intent: Extract<AgentIntent, { kind: 'wait' }>): AgentIntentDispatch {
  switch (intent.condition) {
    case 'selector_visible': {
      if (intent.selector === undefined || intent.selector.length === 0) {
        return { ok: false, reason: 'wait:selector_visible requires a selector' };
      }
      // Build a rendered-visibility predicate. DOM existence alone is not
      // enough: display:none / visibility:hidden / opacity:0 / skipped
      // content-visibility / zero-area targets are not yet human-actionable.
      // JSON.stringify makes the selector a safe JS string literal (no
      // predicate injection from the selector).
      // #139 — the box's waitFor runs the predicate as a WebDriver FUNCTION BODY
      // (execute/sync wraps it in `function(){ … }`), so it needs an explicit
      // `return` to yield a value — a bare expression returns undefined → the
      // condition is never met → a full 5s timeout. Emit a return-statement.
      //
      // ⛔ SHADOW ROOTS (P-3, 2026-09-06). The harness supplied the native template while
      // answering the "can we drop this predicate" question, and it reads
      // `!!deepQuerySelector(sel)` — the harness's own selector resolution PIERCES
      // shadow roots. A plain `document.querySelector` does not, so this predicate
      // could not see an element the native path finds, and the two waits disagreed
      // about whether the same selector matched. That is worse than either
      // behaviour alone: the reason this predicate exists is that it does MORE than
      // the native one (rendered visibility, which the native wait does not check at
      // all), so it must not quietly do LESS on another axis. ⚠️ What the harness supplied is
      // the CALL, not the implementation — the walker below is our own
      // breadth-first descent into open shadow roots, so it matches the native path's
      // REACH and is not claimed to match its traversal. Kept small because it ships
      // as a source string on every wait.
      //
      // ⚠️ The walk is BUDGETED (2,000 elements examined) and runs only when the
      // light-DOM query misses, which during a wait is the common case — an
      // unbounded full-tree descent on every poll of a large page is a cost the
      // customer pays for a shape most pages do not have. Named rather than hidden:
      // past the budget this reports "not found", i.e. it keeps waiting, which is
      // the same answer it gave before shadow roots were searched at all.
      const selector = JSON.stringify(intent.selector);
      const predicate = [
        'const deepQuery = (sel) => {',
        'const direct = document.querySelector(sel);',
        'if (direct !== null && direct !== undefined) return direct;',
        // Every step is feature-guarded: this string is evaluated verbatim on
        // whatever the page happens to be, and a TypeError here does not fail the
        // wait honestly — it fails it as a timeout, which reads as "the element
        // never appeared". A predicate that can throw is a predicate that lies.
        "if (typeof document.querySelectorAll !== 'function') return null;",
        'let budget = 2000;',
        'const queue = [document];',
        'while (queue.length > 0 && budget > 0) {',
        'const node = queue.shift();',
        "if (node === null || node === undefined || typeof node.querySelectorAll !== 'function') continue;",
        "const hosts = node.querySelectorAll('*');",
        'for (let index = 0; index < hosts.length && budget > 0; index += 1) {',
        'budget -= 1;',
        'const root = hosts[index].shadowRoot;',
        'if (root === null || root === undefined) continue;',
        "const found = typeof root.querySelector === 'function' ? root.querySelector(sel) : null;",
        'if (found !== null && found !== undefined) return found;',
        'queue.push(root);',
        '}',
        '}',
        'return null;',
        '};',
        `const element = deepQuery(${selector});`,
        'if (element === null) return false;',
        'const rect = element.getBoundingClientRect();',
        'if (!(rect.width > 0 && rect.height > 0)) return false;',
        "if (typeof element.checkVisibility === 'function') {",
        'try {',
        'return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });',
        '} catch {}',
        '}',
        // Ascend THROUGH shadow boundaries: `parentElement` is null at a shadow
        // root, so a hidden host outside the root would otherwise never be
        // consulted and a target inside a `display:none` custom element would read
        // as visible.
        'let current = element;',
        'while (current !== null && current !== undefined) {',
        'const style = getComputedStyle(current);',
        "if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;",
        'const opacity = Number.parseFloat(style.opacity);',
        'if (!Number.isNaN(opacity) && opacity <= 0) return false;',
        'const parent = current.parentElement;',
        'if (parent !== null && parent !== undefined) { current = parent; continue; }',
        "const rootNode = typeof current.getRootNode === 'function' ? current.getRootNode() : null;",
        'current = rootNode !== null && rootNode !== undefined && rootNode.host ? rootNode.host : null;',
        '}',
        'return true;',
      ].join(' ');
      const params: Record<string, unknown> = { predicate };
      if (intent.timeoutMs !== undefined) {
        const seconds = Math.ceil(intent.timeoutMs / 1000);
        // wait_for requires a positive integer, and this ROUNDS UP — any
        // positive timeout asks for at least one whole second. Only a zero or
        // negative timeout omits the field and falls back to the device's own
        // 30s default. ⛔ The rounding is why a caller that debits a budget for
        // this wait must debit the SECOND, not the milliseconds it configured:
        // see the element-wait clamp in agent-executor-control-plane.ts.
        if (seconds >= 1) params.timeout_seconds = seconds;
      }
      return { ok: true, intentName: 'wait_for', params };
    }

    case 'idle': {
      // #139 — the decomposer reliably inserts a `wait{condition:idle}` settle
      // step after a navigate ("let the page finish loading"). `readyState`
      // alone is insufficient for SPAs: it is commonly already `complete` while
      // hydration, web fonts and late resources are still moving. So the settle
      // requires a human-sized 500ms quiet window after the load event, with a
      // 3s ceiling so an animated/live page cannot stall the plan forever.
      // Previously this returned ok:false → the executor HALTED the whole plan on
      // the settle step, so a "navigate then screenshot" plan lost its screenshot.
      //
      // ⛔ WHERE IT RUNS, and it is not behind a world boundary. The harness established
      // (V-2026-09-04, correcting its own earlier answer) that
      // `WebDriverClient.waitFor` polls by calling `executeScript(predicate)`, and
      // every `executeScript` compiles in the PAGE'S MAIN WORLD through
      // page-replaceable built-ins. So everything this touches is observable to a
      // page that instruments itself. Per wait variant:
      //
      //   {seconds}      no script at all                      carries none
      //   {url_matches}  native `GET /url` since `2b3ae7793`   carries none
      //   {selector}     main-world JS                         OBSERVABLE
      //   {text}         main-world JS                         OBSERVABLE
      //   this predicate main-world JS                         OBSERVABLE
      //
      // ⛔⛔ R7 (2026-09-20) — THIS PREDICATE IS NOW STATELESS, and that is the
      // whole change. It used to keep its poll-to-poll state on
      // `globalThis[Symbol.for('idle-settle.v1')]`, which gave a page three
      // things it should never have had:
      //
      //   1. A CONSTANT, PRODUCT-WIDE MEMBERSHIP TEST. One line —
      //      `Object.getOwnPropertySymbols(globalThis).some((s) => s.description
      //      === 'idle-settle.v1')` — answered "is this browser one of theirs?"
      //      during the wait AND after it on every failure path, since the key was
      //      deleted only on the success return. It was also a join key: the same
      //      string in every session of every customer.
      //   2. A DENIAL OF SERVICE THE PAGE CHOSE. Making that property getter-only
      //      made `root[key] = state` ineffective, so `readySince` reset on every
      //      poll and the predicate returned false for ever — and with no timeout
      //      from the planner the device's own `HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_
      //      SECONDS` (30) applied. Thirty seconds of a rented phone per navigate,
      //      at the page's choosing, inside a 180s turn.
      //   3. A LEAKED OBSERVER PER POLL. A getter returning a fresh object each
      //      poll drove the install branch every poll: a new document-wide
      //      `MutationObserver`, never disconnected.
      //
      // All three were properties of KEEPING STATE IN THE PAGE. Reading the same
      // facts out of interfaces the page already computes for itself removes them
      // outright rather than renaming them: there is no global, no symbol, no
      // observer, and nothing to clean up on any path. `document.readyState`, the
      // navigation entry's `loadEventEnd`, the newest resource `responseEnd` and
      // `document.fonts.status` are all read-only reads of things the page has
      // anyway. ⚠️ They are still main-world reads through replaceable accessors:
      // a page that has replaced `performance.getEntriesByType` still sees the
      // call, on the device's own poll cadence. This removes the constant name,
      // the stall and the leak. It does not make the wait unobservable, and
      // nothing here may be described as such.
      //
      // ⛔ WHAT IS LOST, said plainly: DOM-ONLY MUTATION ACTIVITY WITH NO NETWORK.
      // The old `MutationObserver` extended the quiet window when script mutated
      // the document without fetching anything (a hydration pass over data already
      // in hand, a JS animation). A stateless predicate cannot see that — a
      // mutation leaves no timestamp for a later poll to read — so the settle can
      // now return true while such a page is still moving, where before it would
      // have waited to the 3s ceiling. Network activity BETWEEN polls is still
      // seen, because Resource Timing entries persist. No task in the eval corpus
      // depends on the lost case: the fake device models a settle by the fixture's
      // own `settleMs` and never evaluates this source (see
      // `agent-eval-wait-discriminator.test.ts`, which says so next to the
      // instrument). The real-page cost is bounded by the ceiling either way: at
      // worst the settle ends up to 3s early on a purely DOM-driven hydration, and
      // the step after it fails on its own selector with a clearer reason.
      //
      // ⛔ AND IT ALWAYS ASKS FOR ITS OWN TIMEOUT (see below). The 30s device
      // default is never what bounds a settle now, whoever is on the other end.
      //
      // ⛔ THE NATIVE JS-FREE FORM IS STILL NOT AVAILABLE FOR THIS. The harness answered
      // 2026-09-06: `{ for: { selector, appears } }` compiles to
      // `!!deepQuerySelector(arguments[0]) === arguments[1]` — EXISTENCE ONLY. The
      // script-free `{ for: { seconds } }` form carries no script at all, but it
      // is a sleep, not a settle: it would wait a fixed time whatever the page is
      // doing, which is both slower on a fast page and a constant of its own.
      // Named as the alternative that was considered, not as one that was missed.
      //
      // ⭐ The harness side's larger finding, which is theirs and is unchanged by this: the tell
      // is the CADENCE, not the call. `pollIntervalMs` is a fixed 250 ms with no
      // jitter, so an instrumented page sees the same reads at a machine-perfect
      // interval. That interval is the device's to change, not ours (device Q5).
      //
      // `return …;` — the box waitFor evaluates the predicate as a function body
      // (see selector_visible above); a bare expression yields undefined.
      const predicate = [
        // Nothing before the load event can be settled, and this is the cheapest
        // read of the three, so it is first.
        "if (document.readyState !== 'complete') return false;",
        'const now = performance.now();',
        // Every step is feature-guarded: this string is evaluated verbatim on
        // whatever the page happens to be, and a TypeError here does not fail the
        // wait honestly — it fails it as a timeout, which reads as "the page never
        // settled". A predicate that can throw is a predicate that lies.
        "const entries = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('navigation') : null;",
        'const navigation = entries !== null && entries.length > 0 ? entries[0] : null;',
        'const loadEnd =',
        "navigation !== null && navigation !== undefined && typeof navigation.loadEventEnd === 'number' && navigation.loadEventEnd > 0",
        '? navigation.loadEventEnd',
        ': null;',
        // ⛔ THE CEILING IS MEASURED FROM THE LOAD EVENT, AND IT ONLY MEANS WHAT
        // IT USED TO WHILE THAT LOAD EVENT IS THIS WAIT'S OWN. The old ceiling
        // was "three seconds since THIS wait first saw the document complete",
        // which needed stored state. A stateless reader has only one shared
        // instant to measure from — `loadEventEnd` — and for the settle a
        // navigate inserts, the two are the same instant.
        //
        // ⛔ THEY ARE NOT THE SAME INSTANT FOR A SETTLE THAT COMES LATER, and an
        // unbounded `now - loadEnd >= ceiling` would therefore NO-OP EVERY ONE OF
        // THEM: a settle after a tap that changes the view without a navigation
        // (a same-document route change, a "load more") finds a load event
        // minutes old and returns true on its FIRST poll, whatever the page is
        // doing — which is not a stricter settle, it is no settle at all. So the
        // ceiling is claimed only while the load event is recent enough that a
        // settle STARTING at it could still be polling now: ceiling + the
        // timeout every settle sends. Past that, the quiet window below decides,
        // which is the right answer for a page that loaded long ago.
        //
        // ⚠️ THE RESIDUAL, NAMED: a settle dispatched between the ceiling and
        // that bound after its page's load event still reads the ceiling as
        // already reached. Statelessly the two cases are indistinguishable —
        // nothing in the page records when this wait began — and the bound is
        // chosen so the case the settle exists for (immediately after a
        // navigate) keeps exactly the behaviour it had.
        `if (loadEnd !== null && now - loadEnd >= ${String(SETTLE_CEILING_MS)} && now - loadEnd < ${String(SETTLE_CEILING_APPLIES_WITHIN_MS)}) return true;`,
        // The newest network completion, bounded the way the old one was: the
        // entries are START-ordered, so the last entry need not be the latest to
        // finish, and a page with thousands of resources must not be walked whole.
        'let latest = loadEnd !== null ? loadEnd : 0;',
        "if (typeof performance.getEntriesByType === 'function') {",
        "const resources = performance.getEntriesByType('resource');",
        'for (let index = Math.max(0, resources.length - 64); index < resources.length; index += 1) {',
        'const responseEnd = resources[index].responseEnd;',
        "if (typeof responseEnd === 'number' && Number.isFinite(responseEnd)) latest = Math.max(latest, responseEnd);",
        '}',
        '}',
        // A document that is `complete` with no navigation entry and no resources
        // has nothing left to wait for, and `latest` is 0 — so the quiet test
        // below passes at once. That is the degradation this branch chooses on a
        // browsing context without Navigation Timing: settle immediately, which is
        // exactly what the plan did before a settle existed at all. It is never a
        // silent 30s stall, because the timeout below is always sent.
        "const fontsReady = !('fonts' in document) || document.fonts.status === 'loaded';",
        `return fontsReady && now - latest >= ${String(SETTLE_QUIET_MS)};`,
      ].join(' ');
      const params: Record<string, unknown> = {
        predicate,
      };
      // ⛔ A SETTLE ALWAYS NAMES ITS OWN TIMEOUT. Omitting the field handed the
      // wait to `HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS` — thirty seconds — which
      // is not a number anyone here chose and is a third of the turn's whole wall
      // clock. The ceiling above is 3s, so ceiling + margin is what a settle can
      // honestly need; a planner that names a longer one is still obeyed, because
      // it is asking about a specific page rather than falling through to a
      // default. A settle that times out stays NON-FATAL exactly as today (the
      // executor's `wait` exemption to halt-on-first-failure).
      const requested =
        intent.timeoutMs !== undefined
          ? Math.ceil(intent.timeoutMs / 1000)
          : SETTLE_TIMEOUT_SECONDS;
      params.timeout_seconds = Math.max(SETTLE_TIMEOUT_SECONDS, requested);
      return { ok: true, intentName: 'wait_for', params };
    }
  }
}

function mapCapture(intent: Extract<AgentIntent, { kind: 'capture' }>): AgentIntentDispatch {
  switch (intent.capture) {
    case 'screenshot':
      return { ok: true, intentName: 'screenshot', params: {} };

    case 'dom_snapshot':
      return { ok: true, intentName: 'get_page_source', params: {} };

    case 'pdf':
      // The harness exposes no PDF capture intent.
      return { ok: false, reason: 'capture:pdf has no harness intent' };
  }
}
