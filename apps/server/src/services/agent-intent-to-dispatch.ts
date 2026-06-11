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
// inputParams (the Swift `Data` wire codec is still pending Agent-3
// confirmation — see the harness-control-protocol header). So this mapping
// is stable regardless of how the envelope is ultimately encoded.
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

export type AgentIntentDispatch =
  | { ok: true; intentName: HarnessIntentName; params: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Map one customer AgentIntent to the harness `{ intentName, params }`.
 *
 * Clean 1:1 mappings (navigate / tap→click / type→send_keys /
 * scroll→scroll / wait:selector_visible→wait_for / screenshot /
 * dom_snapshot→get_page_source) return `{ ok: true, ... }`. Verbs with no
 * faithful harness target (swipe, wait:idle, pdf) and intents missing a
 * required field return `{ ok: false, reason }`.
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
      return {
        ok: true,
        intentName: 'behavioral_pause',
        params:
          intent.reading_word_count !== undefined
            ? { kind: 'reading', word_count: intent.reading_word_count }
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

    case 'type':
      if (intent.selector === undefined || intent.selector.length === 0) {
        return { ok: false, reason: 'interact:type requires a selector' };
      }
      if (intent.value === undefined) {
        return { ok: false, reason: 'interact:type requires a value (the text to type)' };
      }
      return {
        ok: true,
        intentName: 'send_keys',
        params: {
          strategy: 'css selector',
          value: intent.selector,
          text: intent.value,
          // W1150 (A3 W1149) — forwarded only when set: sensitive fields get
          // no visible typo-corrections harness-side (and are never logged).
          ...(intent.sensitive === undefined ? {} : { sensitive: intent.sensitive }),
        },
      };

    case 'scroll':
      // The current AgentIntent scroll carries no direction/distance, so we
      // emit a bare scroll and let the harness apply its persona defaults
      // (down / 600px). Increment-2 (c) adds direction + distance_px.
      return { ok: true, intentName: 'scroll', params: {} };

    case 'press':
      // W540 — the DRIVER path supports press today (agent-executor →
      // sessions.interact press). The HARNESS control-plane intent
      // (press_key, A3-W677 proposal: params { key }) is NOT in
      // HARNESS_INTENT_NAMES yet — A3 lands the handler after contract
      // confirmation. Until then fail closed here (swipe pattern) so we
      // never emit an intentName the harness would reject.
      return {
        ok: false,
        reason:
          'interact:press has no harness intent yet (A3-W677 press_key pending); driver-path sessions support press',
      };

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
      // Build a truthy JS predicate. JSON.stringify makes the selector a
      // safe JS string literal (no predicate injection from the selector).
      const predicate = `!!document.querySelector(${JSON.stringify(intent.selector)})`;
      const params: Record<string, unknown> = { predicate };
      if (intent.timeoutMs !== undefined) {
        const seconds = Math.ceil(intent.timeoutMs / 1000);
        // wait_for requires a positive integer; sub-second / zero waits fall
        // back to the harness default (30s) by omitting the field.
        if (seconds >= 1) params.timeout_seconds = seconds;
      }
      return { ok: true, intentName: 'wait_for', params };
    }

    case 'idle':
      // No harness predicate maps to "network/page idle"; the harness
      // wait_for needs a concrete JS predicate. Don't fabricate one.
      return {
        ok: false,
        reason: 'wait:idle has no harness predicate; pending vocab reconciliation',
      };
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
