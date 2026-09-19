// An unknown key on a harness intent RESULT is stripped and counted — not fatal.
//
// 2026-09-18: the harness shipped `focus_tap_unoccluded_checked` (send_keys) and
// `hit_via_own_label` (perceive elements) as additive keys, and every per-intent
// result schema was `.strict()`, so every such result failed its contract until
// the control plane declared them. Typed steps would have failed; pre-tap looks
// fell back to unchecked taps. The rule agreed with the harness owner:
//
//   · an UNKNOWN key is removed from what the executor sees, and counted;
//   · a KNOWN key with a wrong type or value is still a contract failure.
//
// Each half is pinned below, the incident is replayed end to end through the
// fleet connection, and the intent-result ENVELOPE — which deliberately stays
// strict — is pinned too, so neither side of the line can drift silently.

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  HARNESS_INTENT_NAMES,
  HARNESS_INTENT_RESULT_SCHEMAS,
  HarnessOutboundSchema,
  type HarnessIntentName,
  type IntentDispatch,
} from '../../src/schemas/harness-control-protocol.js';
import {
  encodeWireData,
  parseIntentResult,
  HarnessWireCodecError,
  RESULT_ECHO_TRIPWIRE_KEYS,
} from '../../src/services/harness-control-codec.js';
import {
  pruneUnknownKeys,
  sanitiseKeyName,
  UnknownResultKeyReporter,
  UNKNOWN_RESULT_KEY_LOG_EVERY,
  UNKNOWN_RESULT_KEY_LOG_KINDS_MAX,
  UNKNOWN_RESULT_KEY_LOG_NAMES_MAX,
  UNKNOWN_RESULT_KEY_NAME_MAX_CHARS,
  UNKNOWN_RESULT_KEY_PATHS_MAX,
  type UnknownResultKeysReport,
} from '../../src/services/harness-result-unknown-keys.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import type { Logger } from '../../src/lib/logger.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './_helpers/code-only.js';

const ENVELOPE = {
  type: 'intentResult' as const,
  sessionId: 'agt_1',
  intentId: 'int_1',
  success: true as const,
  durationMs: 7,
};

function frame(output: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...ENVELOPE, outputData: encodeWireData(output), ...extra };
}

function parseWith(
  intent: HarnessIntentName,
  output: unknown,
): { output: unknown; reports: UnknownResultKeysReport[] } {
  const reports: UnknownResultKeysReport[] = [];
  const parsed = parseIntentResult(frame(output), intent, (r) => reports.push(r));
  return { output: parsed.outputData, reports };
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return { logger, warn };
}

function metricsWithCounter(): MetricsRegistry {
  const metrics = new MetricsRegistry();
  metrics.registerCounter(METRIC_NAMES.harnessIntentResultUnknownKeyTotal, 'unknown keys', [
    'intent',
  ]);
  return metrics;
}

const SEND_KEYS_WITH_CHECK = {
  typed_into: 'el_1',
  length: 5,
  truncated: false,
  behavioral: true,
  focus_tap_unoccluded_checked: true,
};

// ── the incident ───────────────────────────────────────────────────────────

describe('the 2026-09-18 incident, replayed', () => {
  it('CRITICAL a send_keys result carrying focus_tap_unoccluded_checked, against a schema that does NOT declare it, is ACCEPTED through the live fleet connection with the key stripped and counted', async () => {
    const live = HARNESS_INTENT_RESULT_SCHEMAS.send_keys;
    // The schema as it stood before the control plane declared the key.
    const preFix = (live as z.AnyZodObject).omit({ focus_tap_unoccluded_checked: true });
    // Precondition control: this IS the incident. The pre-fix schema, parsed
    // directly, refuses the device's result. Without this the replay could pass
    // against a schema that never rejected anything.
    expect(preFix.safeParse(SEND_KEYS_WITH_CHECK).success).toBe(false);

    const metrics = metricsWithCounter();
    const { logger, warn } = fakeLogger();
    const reporter = new UnknownResultKeyReporter({ metrics, logger });
    HARNESS_INTENT_RESULT_SCHEMAS.send_keys = preFix;
    try {
      // Positional: 13 historical handlers, then the unknown-result-key observer.
      const registry = new FleetControlRegistry(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reporter.observe,
      );
      const conn = registry.register('node-1', () => {});
      const dispatch: IntentDispatch = {
        type: 'intentDispatch',
        sessionId: ENVELOPE.sessionId,
        intentId: ENVELOPE.intentId,
        intentName: 'send_keys',
        inputParams: encodeWireData({ strategy: 'css selector', value: '#q', text: 'hello' }),
      };
      const pending = conn.correlator.dispatch(dispatch);
      conn.handleInbound(JSON.stringify(frame(SEND_KEYS_WITH_CHECK)));
      const result = await pending;

      expect(result.success, result.errorMessage).toBe(true);
      expect(result.outputData).toEqual({
        typed_into: 'el_1',
        length: 5,
        truncated: false,
        behavioral: true,
      });
      expect(
        Object.prototype.hasOwnProperty.call(result.outputData, 'focus_tap_unoccluded_checked'),
      ).toBe(false);
      expect(
        metrics.getValue(METRIC_NAMES.harnessIntentResultUnknownKeyTotal, { intent: 'send_keys' }),
      ).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        event: 'intent_result_unknown_keys',
        intent: 'send_keys',
        unknownKeys: ['focus_tap_unoccluded_checked'],
        unknownKeyCount: 1,
      });
    } finally {
      HARNESS_INTENT_RESULT_SCHEMAS.send_keys = live;
    }
  });

  it('and with the key DECLARED (today), it reaches the executor and nothing is counted', () => {
    const { output, reports } = parseWith('send_keys', SEND_KEYS_WITH_CHECK);
    expect(output).toEqual(SEND_KEYS_WITH_CHECK);
    expect(reports).toEqual([]);
  });
});

// ── half one: unknown → stripped + counted ─────────────────────────────────

describe('an unknown key is stripped and counted', () => {
  it('at the top level: removed from the value the executor sees, and reported by name', () => {
    const { output, reports } = parseWith('click', {
      clicked: '#go',
      behavioral: true,
      activated: true,
      brand_new_field: { nested: 1 },
    });
    expect(output).toEqual({ clicked: '#go', behavioral: true, activated: true });
    expect(reports).toEqual([{ intent: 'click', keyPaths: ['brand_new_field'], truncated: false }]);
  });

  it('at EVERY nested level of a perceive-by-selector answer, collapsing array indices to [] so 3 elements carrying one new key are ONE path', () => {
    const element = (id: number): Record<string, unknown> => ({
      id,
      type: 'input',
      label: 'Email',
      selector: '#email',
      bounds: { x: 1, y: 2, width: 3, height: 4, z_new: 1 },
      tap_point: { x: 2, y: 4, t_new: 1 },
      hit: {
        type: 'input',
        label: 'Email',
        selector: '#email',
        bounds: { x: 1, y: 2, width: 3, height: 4, hb_new: 1 },
        h_new: 1,
      },
      occluded: false,
      occlusion_reason: null,
      hit_via_own_label: true,
      state: { visible: true, enabled: true, focused: false, s_new: 1 },
      position_summary: 'top',
      e_new: 1,
    });
    const payload = {
      value: {
        url: 'https://example.test/',
        title: 'T',
        elements: [element(0), element(1), element(2)],
        truncated: false,
        total_matched: 3,
        resolved_by: 'native',
        v_new: 1,
      },
      top_new: 1,
    };
    const { output, reports } = parseWith('perceive', payload);
    const clean = (id: number): Record<string, unknown> => ({
      id,
      type: 'input',
      label: 'Email',
      selector: '#email',
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      tap_point: { x: 2, y: 4 },
      hit: {
        type: 'input',
        label: 'Email',
        selector: '#email',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      },
      occluded: false,
      occlusion_reason: null,
      hit_via_own_label: true,
      state: { visible: true, enabled: true, focused: false },
      position_summary: 'top',
    });
    expect(output).toEqual({
      value: {
        url: 'https://example.test/',
        title: 'T',
        elements: [clean(0), clean(1), clean(2)],
        truncated: false,
        total_matched: 3,
        resolved_by: 'native',
      },
    });
    expect([...(reports[0]?.keyPaths ?? [])].sort()).toEqual(
      [
        'top_new',
        'value.v_new',
        'value.elements[].e_new',
        'value.elements[].bounds.z_new',
        'value.elements[].tap_point.t_new',
        'value.elements[].hit.h_new',
        'value.elements[].hit.bounds.hb_new',
        'value.elements[].state.s_new',
      ].sort(),
    );
  });

  it('the input object is never mutated, and an unchanged result is the same reference', () => {
    const payload = { clicked: '#go', behavioral: true, activated: true, extra: 1 };
    const snapshot = JSON.stringify(payload);
    const schema = HARNESS_INTENT_RESULT_SCHEMAS.click;
    pruneUnknownKeys(schema, payload);
    expect(JSON.stringify(payload)).toBe(snapshot);
    const clean = { clicked: '#go', behavioral: true, activated: true };
    expect(pruneUnknownKeys(schema, clean).value).toBe(clean);
  });

  it('an observer that throws does not turn a valid result into a failed step', () => {
    const parsed = parseIntentResult(
      frame({ clicked: '#go', behavioral: true, activated: true, extra: 1 }),
      'click',
      () => {
        throw new Error('observer broke');
      },
    );
    expect(parsed.success).toBe(true);
    expect(parsed.outputData).toEqual({ clicked: '#go', behavioral: true, activated: true });
  });

  it('positions whose keys are DATA are untouched: extract.value and execute_script.value keep every key', () => {
    const extracted = { title: 'x', anything: { deep: [1, { k: 2 }] } };
    expect(parseWith('extract', { value: extracted })).toEqual({
      output: { value: extracted },
      reports: [],
    });
    const scripted = { whatever: 1, nested: { a: 'b' } };
    expect(parseWith('execute_script', { value: scripted })).toEqual({
      output: { value: scripted },
      reports: [],
    });
  });

  it('a key named __proto__ is stripped as unknown and cannot reach the prototype', () => {
    const raw =
      '{"clicked":"#go","behavioral":true,"activated":true,"__proto__":{"polluted":true}}';
    const parsed = parseIntentResult(
      { ...ENVELOPE, outputData: Buffer.from(raw, 'utf8').toString('base64') },
      'click',
    );
    const out = parsed.outputData as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['clicked', 'behavioral', 'activated']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('key names are sanitised and length-capped before they can reach a log line', () => {
    expect(sanitiseKeyName('a.b\nc"<x>')).toBe('a?b?c??x?');
    const long = 'k'.repeat(UNKNOWN_RESULT_KEY_NAME_MAX_CHARS + 50);
    expect(sanitiseKeyName(long)).toBe(`${'k'.repeat(UNKNOWN_RESULT_KEY_NAME_MAX_CHARS)}~`);
    const { reports } = parseWith('click', {
      clicked: '#go',
      behavioral: true,
      activated: true,
      'evil.key\n': 1,
    });
    expect(reports[0]?.keyPaths).toEqual(['evil?key?']);
  });

  it('the number of paths tracked per result is capped, and every unknown key is still stripped', () => {
    const payload: Record<string, unknown> = { clicked: '#go', behavioral: true, activated: true };
    for (let i = 0; i < UNKNOWN_RESULT_KEY_PATHS_MAX + 44; i += 1) payload[`k${i}`] = i;
    const { output, reports } = parseWith('click', payload);
    expect(output).toEqual({ clicked: '#go', behavioral: true, activated: true });
    expect(reports[0]?.keyPaths).toHaveLength(UNKNOWN_RESULT_KEY_PATHS_MAX);
    expect(reports[0]?.truncated).toBe(true);
  });
});

// ── half two: known key, wrong type or value → still rejected ──────────────

describe('a KNOWN key with a wrong type or value is still a contract failure', () => {
  it('CRITICAL send_keys focus_tap_unoccluded_checked as a string is rejected — even with an unknown key beside it, which is then NOT counted', () => {
    const reports: UnknownResultKeysReport[] = [];
    expect(() =>
      parseIntentResult(
        frame({ ...SEND_KEYS_WITH_CHECK, focus_tap_unoccluded_checked: 'yes', extra: 1 }),
        'send_keys',
        (r) => reports.push(r),
      ),
    ).toThrow(HarnessWireCodecError);
    // A rejected result is not reported: for a cross-intent payload every key
    // would read as "new", sending an operator after a device that sent nothing new.
    expect(reports).toEqual([]);
  });

  it('a nested known key keeps its type too: perceive hit_via_own_label as a number is rejected', () => {
    expect(() =>
      parseWith('perceive', {
        value: {
          url: 'u',
          title: 't',
          elements: [
            {
              id: 0,
              type: 'input',
              label: 'l',
              selector: '#s',
              bounds: { x: 0, y: 0, width: 1, height: 1 },
              hit_via_own_label: 1,
              state: { visible: true, enabled: true, focused: false },
              position_summary: 'p',
            },
          ],
          truncated: false,
          total_matched: 1,
        },
      }),
    ).toThrow(HarnessWireCodecError);
  });

  it('CRITICAL a key ANY variant declares is known: navigate loadedAtTimeout:false is still rejected rather than stripped into the plain {url} variant', () => {
    expect(() => parseWith('navigate', { url: 'https://x.test/', loadedAtTimeout: false })).toThrow(
      HarnessWireCodecError,
    );
    // And the declared variant is not re-routed by an unknown key beside it.
    const { output, reports } = parseWith('navigate', {
      url: 'https://x.test/',
      loadedAtTimeout: true,
      extra: 1,
    });
    expect(output).toEqual({ url: 'https://x.test/', loadedAtTimeout: true });
    expect(reports[0]?.keyPaths).toEqual(['extra']);
  });

  it('a key declared by the OTHER discriminated variant is still refused: results_visible on a truncated search', () => {
    expect(() =>
      parseWith('search', { submitted: false, query_truncated: true, results_visible: true }),
    ).toThrow(HarnessWireCodecError);
  });

  it('another intent’s payload is still refused, not stripped to nothing', () => {
    expect(() => parseWith('navigate', { pressed: 'Enter' })).toThrow(HarnessWireCodecError);
  });
});

// ── every strict level of every intent's result ───────────────────────────

/** Valid results covering every variant shape with nested objects. */
const SAMPLES: ReadonlyArray<readonly [HarnessIntentName, unknown]> = [
  ['navigate', { url: 'https://e.test/', http_status: 200 }],
  ['navigate', { url: 'https://e.test/', loadedAtTimeout: true }],
  ['back', { url: 'https://e.test/a', action: 'back' }],
  ['back', { action: 'back', loadedAtTimeout: true }],
  ['forward', { url: 'https://e.test/b', action: 'forward' }],
  ['forward', { action: 'forward', loadedAtTimeout: true }],
  ['click', { clicked: 'coords', behavioral: true, activated: null }],
  ['send_keys', SEND_KEYS_WITH_CHECK],
  ['press_key', { pressed: 'Enter' }],
  ['execute_script', { value: null }],
  ['detect_challenge', { challenge_detected: false }],
  [
    'detect_challenge',
    { challenge_detected: true, type: 'turnstile', confidence: 0.9, detail: 'd' },
  ],
  ['extract', { value: { title: 'Example' } }],
  ['screenshot', { screenshot_b64: 'aGk=', format: 'png', full_page: false, annotated: false }],
  ['get_page_source', { source: '<html></html>', truncated: false }],
  [
    'perceive',
    {
      value: {
        url: 'https://e.test/',
        title: 'E',
        elements: [
          {
            id: 0,
            type: 'button',
            label: 'Go',
            selector: '#go',
            bounds: { x: 1, y: 2, width: 3, height: 4 },
            tap_point: { x: 2, y: 4 },
            hit: {
              type: 'other',
              label: '',
              selector: 'div',
              bounds: { x: 0, y: 0, width: 9, height: 9 },
            },
            occluded: true,
            occlusion_reason: 'hit_is_not_target_or_descendant',
            hit_via_own_label: false,
            state: { visible: true, enabled: true, focused: false, checked: false },
            position_summary: 'top',
          },
        ],
        truncated: false,
        total_matched: 1,
        resolved_by: 'script',
      },
    },
  ],
  ['wait_for', { waited: true, timeout_capped: false }],
  [
    'scroll',
    {
      scrolled: 1,
      requested: 1,
      scrolled_measured: true,
      flicks: 1,
      steps: 1,
      behavioral: true,
      distance_capped: false,
    },
  ],
  ['behavioral_pause', { paused_ms: 5, capped: false, behavioral: true }],
  ['fill_form', { fields_filled: 1, submitted: false, truncated: false }],
  ['fill_form', { fields_filled: 2, submitted: false, truncated: true, truncated_fields: [2] }],
  ['search', { submitted: true, query_truncated: false, results_visible: true }],
  ['search', { submitted: false, query_truncated: true }],
  ['login', { submitted: true, credentials_truncated: false, logged_in: true }],
  ['login', { submitted: false, credentials_truncated: true, logged_in: false }],
];

/** Positions whose keys are data, where an injected key is legitimately kept. */
const DATA_POSITIONS = new Set(['extract:value', 'execute_script:value']);

/** Every plain-object node of a sample, as a path of keys / array indices. */
function objectNodes(
  value: unknown,
  at: Array<string | number> = [],
): Array<Array<string | number>> {
  if (Array.isArray(value)) return value.flatMap((item, i) => objectNodes(item, [...at, i]));
  if (value === null || typeof value !== 'object') return [];
  return [
    at,
    ...Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      objectNodes(v, [...at, k]),
    ),
  ];
}

function withKeyAt(value: unknown, at: ReadonlyArray<string | number>, key: string): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let node: Record<string | number, unknown> = copy;
  for (const step of at) node = node[step] as Record<string | number, unknown>;
  node[key] = 1;
  return copy;
}

function reportedPath(at: ReadonlyArray<string | number>, key: string): string {
  return [...at, key]
    .map((s) => (typeof s === 'number' ? '[]' : s))
    .join('.')
    .replace(/\.\[\]/g, '[]');
}

describe('every level that is strict today strips instead of failing', () => {
  it('the samples cover every intent (a missing one would silently exempt its schema)', () => {
    expect(new Set(SAMPLES.map(([name]) => name))).toEqual(new Set(HARNESS_INTENT_NAMES));
  });

  it('CRITICAL for every object node of every sample: the strict schema alone REJECTS an injected key there, and the codec accepts, strips it, and names it', () => {
    let exercised = 0;
    for (const [intent, sample] of SAMPLES) {
      const schema = HARNESS_INTENT_RESULT_SCHEMAS[intent];
      const expected = schema.parse(sample);
      for (const at of objectNodes(sample)) {
        const where = `${intent}:${at.join('.')}`;
        if ([...DATA_POSITIONS].some((p) => where.startsWith(p))) continue;
        const injected = withKeyAt(sample, at, 'zz_injected');
        // The level is strict today — so this is a real rejection turned into a strip.
        expect(schema.safeParse(injected).success, `${where} was not strict`).toBe(false);
        const { output, reports } = parseWith(intent, injected);
        expect(output, where).toEqual(expected);
        expect(
          reports.map((r) => r.keyPaths),
          where,
        ).toEqual([[reportedPath(at, 'zz_injected')]]);
        exercised += 1;
      }
    }
    // Anti-vacuity: a broken node walk would make the loop above pass over nothing.
    expect(exercised).toBeGreaterThanOrEqual(30);
  });
});

// ── stripping must not re-route another intent's payload ──────────────────

function acceptsAs(intent: HarnessIntentName, output: unknown): boolean {
  try {
    parseWith(intent, output);
    return true;
  } catch (error) {
    if (error instanceof HarnessWireCodecError) return false;
    throw error;
  }
}

describe('a cross-intent payload is refused exactly as the strict schemas refused it', () => {
  it('CRITICAL back/forward {url, action} for a NAVIGATE dispatch is refused — stripping `action` must not turn it into navigate {url}', () => {
    for (const payload of [
      { url: 'https://e.test/a', action: 'back' },
      { url: 'https://e.test/b', action: 'forward' },
    ]) {
      // Precondition: after the strip, navigate's schema alone WOULD accept it.
      expect(HARNESS_INTENT_RESULT_SCHEMAS.navigate.safeParse({ url: payload.url }).success).toBe(
        true,
      );
      const reports: UnknownResultKeysReport[] = [];
      expect(() => parseIntentResult(frame(payload), 'navigate', (r) => reports.push(r))).toThrow(
        /is a (back|forward) result/,
      );
      // Refused, so not counted as a "new key" either.
      expect(reports).toEqual([]);
    }
  });

  it('CRITICAL exhaustive: every sample of intent A parsed as every other intent B is accepted by the codec ONLY where the strict schema alone accepted it — with and without an extra unknown key', () => {
    let pairs = 0;
    for (const [a, sample] of SAMPLES) {
      for (const b of HARNESS_INTENT_NAMES) {
        if (b === a) continue;
        const strictAccepts = HARNESS_INTENT_RESULT_SCHEMAS[b].safeParse(sample).success;
        expect(acceptsAs(b, sample), `${a} -> ${b}`).toBe(strictAccepts);
        // Cross-intent AND additive: still refused wherever the bare payload was.
        const plusNew = { ...(sample as Record<string, unknown>), zz_brand_new: 1 };
        expect(acceptsAs(b, plusNew), `${a}+new -> ${b}`).toBe(strictAccepts);
        pairs += 1;
      }
    }
    expect(pairs).toBe(SAMPLES.length * (HARNESS_INTENT_NAMES.length - 1));
  });

  it('a genuinely new key that the intent and a sibling BOTH lack is not a better fit for the sibling: the incident payload still passes', () => {
    const { output, reports } = parseWith('navigate', {
      url: 'https://e.test/',
      zz_brand_new: true,
    });
    expect(output).toEqual({ url: 'https://e.test/' });
    expect(reports.map((r) => r.keyPaths)).toEqual([['zz_brand_new']]);
    // A real TIE: execute_script's schema also accepts extract's `{value: {...}}`
    // after stripping the same new key. Equal is not better, so extract keeps it.
    expect(
      HARNESS_INTENT_RESULT_SCHEMAS.execute_script.safeParse({ value: { title: 'E' } }).success,
    ).toBe(true);
    const tie = parseWith('extract', { value: { title: 'E' }, zz_brand_new: 1 });
    expect(tie.output).toEqual({ value: { title: 'E' } });
    expect(tie.reports.map((r) => r.keyPaths)).toEqual([['zz_brand_new']]);
  });
});

describe('an echoed secret-bearing request key stays FATAL', () => {
  const valid: Record<string, Record<string, unknown>> = {
    login: { submitted: true, credentials_truncated: false, logged_in: true },
    search: { submitted: false, query_truncated: false },
    send_keys: { typed_into: 'el_1', length: 5, truncated: false, behavioral: true },
    fill_form: { fields_filled: 1, submitted: false, truncated: false },
  };

  it('CRITICAL each tripwire key on its intent fails the step, and the error names the key but never carries the echoed value', () => {
    let exercised = 0;
    for (const [intent, keys] of Object.entries(RESULT_ECHO_TRIPWIRE_KEYS) as Array<
      [HarnessIntentName, readonly string[]]
    >) {
      const base = valid[intent];
      expect(base, `no valid sample for ${intent}`).toBeDefined();
      for (const key of keys) {
        const reports: UnknownResultKeysReport[] = [];
        let message = '';
        try {
          parseIntentResult(frame({ ...base, [key]: 'must-never-return' }), intent, (r) =>
            reports.push(r),
          );
        } catch (error) {
          expect(error).toBeInstanceOf(HarnessWireCodecError);
          message = (error as Error).message;
        }
        expect(message, `${intent}.${key} was accepted`).toContain(key);
        expect(message).not.toContain('must-never-return');
        expect(reports).toEqual([]);
        exercised += 1;
      }
    }
    expect(exercised).toBeGreaterThanOrEqual(5);
  });

  it('no tripwire key is a DECLARED result key (a valid result must never trip it)', () => {
    for (const [intent, keys] of Object.entries(RESULT_ECHO_TRIPWIRE_KEYS) as Array<
      [HarnessIntentName, readonly string[]]
    >) {
      for (const key of keys) {
        const pruned = pruneUnknownKeys(HARNESS_INTENT_RESULT_SCHEMAS[intent], { [key]: 1 });
        expect(pruned.unknownKeyPaths, `${intent}.${key}`).toEqual([key]);
      }
    }
  });

  it('the tripwire is per intent: `query` on a login result is an ordinary unknown key', () => {
    const { output, reports } = parseWith('login', { ...valid.login, query: 'q' });
    expect(output).toEqual(valid.login);
    expect(reports.map((r) => r.keyPaths)).toEqual([['query']]);
  });
});

// ── what an operator sees ──────────────────────────────────────────────────

describe('the reporter: a closed-label metric and a rate-limited log line', () => {
  const report = (keyPaths: string[], intent: HarnessIntentName = 'perceive') => ({
    intent,
    keyPaths,
    truncated: false,
  });

  it('CRITICAL the metric is labelled by intent ONLY and counts each distinct key; a key name never becomes a label value', () => {
    const metrics = metricsWithCounter();
    const reporter = new UnknownResultKeyReporter({ metrics });
    reporter.observe(report(['a', 'b']));
    reporter.observe(report(['a']));
    expect(
      metrics.getValue(METRIC_NAMES.harnessIntentResultUnknownKeyTotal, { intent: 'perceive' }),
    ).toBe(3);
    const rendered = metrics.render();
    expect(rendered).toContain(
      'driftstack_harness_intent_result_unknown_key_total{intent="perceive"} 3',
    );
    expect(rendered).not.toMatch(/"a"|"b"/);
  });

  it('logs the first of each kind, then every Nth with the running count', () => {
    const { logger, warn } = fakeLogger();
    const reporter = new UnknownResultKeyReporter({ logger });
    for (let i = 0; i < UNKNOWN_RESULT_KEY_LOG_EVERY; i += 1) reporter.observe(report(['x']));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ occurrences: 1, unknownKeys: ['x'] });
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ occurrences: UNKNOWN_RESULT_KEY_LOG_EVERY });
    // A NEW key on the same intent is a new kind: it is logged at once, not
    // hidden behind the throttle of the old one.
    reporter.observe(report(['y']));
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]?.[0]).toMatchObject({ unknownKeys: ['y'], occurrences: 1 });
  });

  it('names at most N keys per line and carries the true count', () => {
    const { logger, warn } = fakeLogger();
    const keys = Array.from({ length: UNKNOWN_RESULT_KEY_LOG_NAMES_MAX + 5 }, (_, i) => `k${i}`);
    new UnknownResultKeyReporter({ logger }).observe(report(keys));
    const line = warn.mock.calls[0]?.[0] as { unknownKeys: string[]; unknownKeyCount: number };
    expect(line.unknownKeys).toHaveLength(UNKNOWN_RESULT_KEY_LOG_NAMES_MAX);
    expect(line.unknownKeyCount).toBe(keys.length);
  });

  it('past the kind cap, new kinds share a per-intent bucket: bounded, and never fully silent', () => {
    const { logger, warn } = fakeLogger();
    const reporter = new UnknownResultKeyReporter({ logger });
    for (let i = 0; i < UNKNOWN_RESULT_KEY_LOG_KINDS_MAX; i += 1)
      reporter.observe(report([`k${i}`]));
    expect(warn).toHaveBeenCalledTimes(UNKNOWN_RESULT_KEY_LOG_KINDS_MAX);
    reporter.observe(report(['beyond_cap_1']));
    expect(warn).toHaveBeenCalledTimes(UNKNOWN_RESULT_KEY_LOG_KINDS_MAX + 1);
    // Rotating names past the cap cannot re-trigger a "first" line each time.
    reporter.observe(report(['beyond_cap_2']));
    expect(warn).toHaveBeenCalledTimes(UNKNOWN_RESULT_KEY_LOG_KINDS_MAX + 1);
  });

  it('the throttle keys each kind on a fixed-size digest, not on the joined key paths (bounded memory per kind)', () => {
    const reporter = new UnknownResultKeyReporter({});
    const longPaths = Array.from(
      { length: UNKNOWN_RESULT_KEY_PATHS_MAX },
      (_, i) => `${'p'.repeat(190)}${i}`,
    );
    reporter.observe(report(longPaths));
    reporter.observe(report(['short']));
    const kinds = [...(reporter as unknown as { kinds: Map<string, number> }).kinds.keys()];
    expect(kinds).toHaveLength(2);
    // intent + space + 40 hex chars, whatever the size of the key set.
    for (const kind of kinds) expect(kind).toMatch(/^perceive [0-9a-f]{40}$/);
  });

  it('a registry that throws costs the result nothing', () => {
    const reporter = new UnknownResultKeyReporter({
      metrics: new MetricsRegistry(), // counter never registered: inc throws
    });
    expect(() => reporter.observe(report(['x']))).not.toThrow();
  });
});

// ── what stays strict ──────────────────────────────────────────────────────

describe('the intent-result ENVELOPE stays strict', () => {
  it('CRITICAL an unknown envelope key is still refused, by the codec and by the inbound union — envelope keys qualify the whole frame (encoding, correlation, verdict), so an unknown one may change what outputData means', () => {
    const withEnvelopeKey = frame(
      { clicked: '#go', behavioral: true, activated: true },
      { outputEncoding: 'gzip' },
    );
    expect(() => parseIntentResult(withEnvelopeKey, 'click')).toThrow();
    expect(HarnessOutboundSchema.safeParse(withEnvelopeKey).success).toBe(false);
    // Control: the same frame without the key is fine, so the refusal is the key.
    expect(
      HarnessOutboundSchema.safeParse(frame({ clicked: '#go', behavioral: true, activated: true }))
        .success,
    ).toBe(true);
  });

  it('an unknown ERROR CODE is still refused — an unknown code changes meaning', () => {
    expect(() =>
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 's',
          intentId: 'i',
          success: false,
          durationMs: 1,
          errorCode: 'intent_brand_new_code',
        },
        'click',
      ),
    ).toThrow();
  });
});

// ── production wiring ──────────────────────────────────────────────────────

/**
 * The top-level arguments of the call whose `(` is at `open`, balancing
 * brackets and skipping strings AND comments — the production call is full of
 * comments with apostrophes ("the customer's sealed store"), which would open a
 * phantom string in a naive scan and swallow the rest of the call.
 */
function topLevelArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      i = text.indexOf('\n', i);
      continue;
    }
    if (c === '/' && next === '*') {
      i = text.indexOf('*/', i) + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  // The repo's comment model, not a hand-rolled pair of regexes: a `/*` inside a
  // line comment (a route path like `/v1/x/*`) opens a block comment for the
  // naive version and swallows real code. See _helpers/code-only.ts.
  const uncomment = (a: string): string => codeOnly(a).trim();
  return args.map(uncomment).filter((a) => a !== '');
}

describe('production wires the reporter', () => {
  it('CRITICAL bootstrap passes an UnknownResultKeyReporter carrying the metrics registry and the logger as the 14th positional argument of the fleet registry — the slot the registry threads into every connection’s dispatch correlator. Absent, unknown keys are still stripped but NOTHING is counted or logged, and no functional test would notice.', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'bootstrap.ts'),
      'utf8',
    );
    const at = src.indexOf('new FleetControlRegistry(');
    expect(at, 'the production registry construction was not found').toBeGreaterThan(0);
    const args = topLevelArgs(src, src.indexOf('(', at));
    // Vacuity: the parse must see the 13 historical handlers, or a truncated
    // parse could put anything in slot 14.
    expect(args, 'positional arguments of new FleetControlRegistry(...)').toHaveLength(14);
    expect(args[13]).toMatch(
      /^new UnknownResultKeyReporter\(\{[\s\S]*metrics: metricsRegistry[\s\S]*logger,?\s*\}\)\.observe$/,
    );
  });
});
