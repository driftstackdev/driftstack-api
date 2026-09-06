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
// (see docs/internal/cross-agent-control-plane-contract.md).
//
// Pure + transport-agnostic on purpose: it produces the params OBJECT and
// validates it against HARNESS_INTENT_PARAM_SCHEMAS, but does NOT serialise
// inputParams. So this mapping is stable regardless of how the envelope is encoded.
//
// ⛔ STALE (2026-08-26) — this said the Swift `Data` wire codec was "still pending
// Agent-3 confirmation". It was RESOLVED 2026-06-05, and the very header this line
// points at says so: "Wire codec (RESOLVED 2026-06-05 by Agent-3): … cross the wire
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
      // W1223 (A3) — reading pauses always request scroll_through: the harness
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
      // friendly→W3C so the harness stays W3C-faithful (A3 bus W115). When the
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
          // W1150 (A3 W1149) — forwarded only when set: sensitive fields get
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
      // W540/W1221 — the harness `press_key` handler is LIVE (A3 W1221): one
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
      // ⛔ SHADOW ROOTS (P-3, 2026-09-06). A3 supplied the native template while
      // answering the "can we drop this predicate" question, and it reads
      // `!!deepQuerySelector(sel)` — the harness's own selector resolution PIERCES
      // shadow roots. A plain `document.querySelector` does not, so this predicate
      // could not see an element the native path finds, and the two waits disagreed
      // about whether the same selector matched. That is worse than either
      // behaviour alone: the reason this predicate exists is that it does MORE than
      // the native one (rendered visibility, which the native wait does not check at
      // all), so it must not quietly do LESS on another axis. ⚠️ What A3 supplied is
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
        // wait_for requires a positive integer; sub-second / zero waits fall
        // back to the harness default (30s) by omitting the field.
        if (seconds >= 1) params.timeout_seconds = seconds;
      }
      return { ok: true, intentName: 'wait_for', params };
    }

    case 'idle': {
      // #139 — the decomposer reliably inserts a `wait{condition:idle}` settle
      // step after a navigate ("let the page finish loading"). `readyState`
      // alone is insufficient for SPAs: it is commonly already `complete` while
      // hydration, web fonts, late resources, and DOM-driven layout are moving.
      // Keep a tiny page-local observer state across the harness's wait_for
      // polls and require a human-sized 500ms quiet window. A 3s post-complete
      // ceiling prevents animated/live pages from stalling the plan forever.
      // Previously this returned ok:false → the executor HALTED the whole plan on
      // the settle step, so a "navigate then screenshot" plan lost its screenshot.
      // ⛔ P-3 (2026-09-06) — TWO corrections to this predicate, both A2-only.
      //
      // 1. THE KEY CARRIED THE COMPANY NAME. It was
      //    `Symbol.for('driftstack.agent.wait.idle.v1')`, assigned on `globalThis`.
      //    `Object.getOwnPropertySymbols(globalThis).map((s) => s.description)` reads
      //    that string out in one line — a product-branded global on a page the
      //    product exists to browse anonymously. Whether page script can actually see
      //    it depends on which JS world the harness evaluates the predicate in, which
      //    is A3's question and still open; the brand is wrong under BOTH answers, so
      //    it is not gated on the answer. The key is now neutral: it says what the
      //    state is for and names nobody.
      //
      // 2. THE OBSERVER OUTLIVED THE WAIT. The MutationObserver was installed ABOVE
      //    the readyState gate, and the only `disconnect()` is on the success return
      //    below. A page that never reaches `readyState === 'complete'` inside the
      //    wait window therefore kept a document-wide subtree observer AND the global
      //    for the rest of its life. It bought nothing there either: the pre-complete
      //    branch already resets `lastActivity` on every poll, so mutations before
      //    `complete` are not information. Installed after the gate, the leak is
      //    bounded by the 3s post-complete ceiling like every other path.
      //
      // ✅ ANSWERED by A3 2026-09-06, so the "should this exist at all" question is
      // now settled rather than open. The native JS-free form
      // (`WaitForParamsSchema` → `{ for: { selector, appears } }`) compiles to
      // `!!deepQuerySelector(arguments[0]) === arguments[1]` in `IntentExecutor` —
      // EXISTENCE ONLY, no display / visibility / opacity / zero-area test.
      // `docs/locked-decisions.md:29` is literal, not shorthand. So switching to it
      // would regress `6d1d80ee6` ("wait for rendered selectors"), and the predicate
      // stays. A3 also answered the world question: `WebDriverClient.waitFor` polls
      // through `/session/<id>/execute/sync`, the W3C execute endpoint, so this runs
      // in the WEBDRIVER world, whose global object page script does not share.
      // ⚠️ Recorded as SOURCE-derived, not measured: neither side has empirically
      // tested the isolation boundary, so this is why the brand had to go regardless
      // rather than a licence to inject freely.
      //
      // `return …;` — the box waitFor evaluates the predicate as a function body
      // (see selector_visible above); a bare expression yields undefined.
      const predicate = [
        "const key = Symbol.for('idle-settle.v1');",
        'const root = globalThis;',
        'const now = performance.now();',
        'let state = root[key];',
        "if (state === undefined || state.document !== document || typeof state.lastActivity !== 'number') {",
        'state = { document, lastActivity: now, readySince: null, observer: null };',
        'root[key] = state;',
        '}',
        "if (document.readyState !== 'complete') {",
        'state.readySince = null;',
        'state.lastActivity = now;',
        'return false;',
        '}',
        // Installed only once the document is complete — see correction 2 above.
        "if (state.observer === null && typeof MutationObserver === 'function' && document.documentElement !== null) {",
        'state.observer = new MutationObserver(() => { state.lastActivity = performance.now(); });',
        'state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });',
        '}',
        'if (state.readySince === null) {',
        'state.readySince = now;',
        'state.lastActivity = now;',
        'return false;',
        '}',
        "if (typeof performance.getEntriesByType === 'function') {",
        "const resources = performance.getEntriesByType('resource');",
        'let latestResourceEnd = 0;',
        'for (let index = Math.max(0, resources.length - 64); index < resources.length; index += 1) {',
        'const responseEnd = resources[index].responseEnd;',
        "if (typeof responseEnd === 'number' && Number.isFinite(responseEnd)) latestResourceEnd = Math.max(latestResourceEnd, responseEnd);",
        '}',
        'state.lastActivity = Math.max(state.lastActivity, latestResourceEnd);',
        '}',
        "const fontsReady = !('fonts' in document) || document.fonts.status === 'loaded';",
        'const quiet = now - state.lastActivity >= 500;',
        'const ceilingReached = now - state.readySince >= 3000;',
        'if ((!fontsReady || !quiet) && !ceilingReached) return false;',
        "if (state.observer !== null && typeof state.observer.disconnect === 'function') state.observer.disconnect();",
        'delete root[key];',
        'return true;',
      ].join(' ');
      const params: Record<string, unknown> = {
        predicate,
      };
      if (intent.timeoutMs !== undefined) {
        const seconds = Math.ceil(intent.timeoutMs / 1000);
        if (seconds >= 1) params.timeout_seconds = seconds;
      }
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
