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
      const selector = JSON.stringify(intent.selector);
      const predicate = [
        `const element = document.querySelector(${selector});`,
        'if (element === null) return false;',
        'const rect = element.getBoundingClientRect();',
        'if (!(rect.width > 0 && rect.height > 0)) return false;',
        "if (typeof element.checkVisibility === 'function') {",
        'try {',
        'return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });',
        '} catch {}',
        '}',
        'for (let current = element; current !== null; current = current.parentElement) {',
        'const style = getComputedStyle(current);',
        "if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;",
        'const opacity = Number.parseFloat(style.opacity);',
        'if (!Number.isNaN(opacity) && opacity <= 0) return false;',
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
      // `return …;` — the box waitFor evaluates the predicate as a function body
      // (see selector_visible above); a bare expression yields undefined.
      const predicate = [
        "const key = Symbol.for('driftstack.agent.wait.idle.v1');",
        'const root = globalThis;',
        'const now = performance.now();',
        'let state = root[key];',
        "if (state === undefined || state.document !== document || typeof state.lastActivity !== 'number') {",
        'state = { document, lastActivity: now, readySince: null, observer: null };',
        'root[key] = state;',
        '}',
        "if (state.observer === null && typeof MutationObserver === 'function' && document.documentElement !== null) {",
        'state.observer = new MutationObserver(() => { state.lastActivity = performance.now(); });',
        'state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });',
        '}',
        "if (document.readyState !== 'complete') {",
        'state.readySince = null;',
        'state.lastActivity = now;',
        'return false;',
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
