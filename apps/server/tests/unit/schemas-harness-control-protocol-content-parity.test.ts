// Drift guard for apps/server/src/schemas/harness-control-protocol.ts.
// The server↔harness intent-dispatch wire contract. This MUST stay in
// lockstep with the canonical Agent-3 contract
// (driftstack/docs/internal/harness-intent-contract.md, grounded in the
// harness IntentExecutor.swift). Divergence here is a cross-agent wire
// bug: the server would dispatch intents the harness can't route, or
// mis-shape params and surface opaque intent_dispatch_error to customers.
//
//   • Server-internal posture pinned: never on @driftstack/api-types;
//     only `z` imported (no api-types dependency).
//   • Drive-bridge gate (item 9) + the open inputParams/outputData
//     codec caveat documented.
//   • 11-intent dispatchable vocab + the 3 reserved JSBridge names.
//   • Caps/defaults: behavioral_pause 300_000ms, wait_for 300s,
//     scroll default 600px/down, wait_for default 30s.
//   • Per-intent param shapes (navigate/click/send_keys/scroll/
//     behavioral_pause/wait_for/execute_script + no-param intents).
//   • intentName→schema map roster.
//   • IntentDispatch + IntentResult envelopes + 6 error codes.
//
// Plus a behavioral block that exercises the schemas (accept/reject)
// so the contract is enforced, not just pinned by regex.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_INTENT_NAMES,
  HARNESS_RESERVED_INTENT_NAMES,
  HARNESS_ERROR_CODES,
  HARNESS_BEHAVIORAL_PAUSE_CAP_MS,
  HARNESS_WAIT_FOR_CAP_SECONDS,
  HARNESS_SCROLL_DEFAULT_DISTANCE_PX,
  HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS,
  HARNESS_INTENT_PARAM_SCHEMAS,
  HarnessIntentNameSchema,
  NavigateParamsSchema,
  ClickParamsSchema,
  SendKeysParamsSchema,
  ScrollParamsSchema,
  BehavioralPauseParamsSchema,
  WaitForParamsSchema,
  ExecuteScriptParamsSchema,
  IntentDispatchSchema,
  IntentResultEnvelopeSchema,
  SessionAssignSchema,
  HarnessErrorCodeSchema,
  HarnessOutboundSchema,
} from '../../src/schemas/harness-control-protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/schemas/harness-control-protocol.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('apps/server/src/schemas/harness-control-protocol.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('module framing pinned: server↔harness wire protocol; canonical source = A3 harness-intent-contract.md', () => {
    expect(body).toMatch(
      /\/\/ Harness control-plane wire protocol — server↔harness intent dispatch\./,
    );
    expect(body).toMatch(
      /Canonical source: driftstack\/docs\/internal\/harness-intent-contract\.md/,
    );
  });

  it('server-internal posture pinned: never on @driftstack/api-types (harness is internal infra, not a customer)', () => {
    expect(body).toMatch(
      /This schema is \*\*server-internal only\*\*\. Like gui-input\.ts \(L-001\),\s*\n?\s*\/\/ it never appears on the customer-facing surface \(`@driftstack\/api-types`\)/,
    );
  });

  it("imports: only z from 'zod' (no api-types dependency — server-internal posture)", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('drive-bridge gate (item 9) + the RESOLVED base64-JSON wire codec documented', () => {
    expect(body).toMatch(/Drive-bridge gate \(ORCHESTRATOR item 9\)/);
    expect(body).toMatch(
      /Wire codec \(RESOLVED 2026-06-05 by Agent-3\): IntentDispatch\.inputParams/,
    );
    expect(body).toMatch(/cross the wire as a BASE64\s*\n?\s*\/\/ STRING of the UTF-8 JSON/);
  });

  it('11-intent dispatchable vocab pinned in canonical order', () => {
    expect(body).toMatch(
      /export const HARNESS_INTENT_NAMES = \[\s*\n?\s*'navigate',\s*\n?\s*'back',\s*\n?\s*'forward',\s*\n?\s*'click',\s*\n?\s*'send_keys',\s*\n?\s*'scroll',\s*\n?\s*'behavioral_pause',\s*\n?\s*'wait_for',\s*\n?\s*'execute_script',\s*\n?\s*'screenshot',\s*\n?\s*'get_page_source',\s*\n?\s*\] as const;/,
    );
  });

  it('3 reserved JSBridge intents pinned (server must NOT dispatch these)', () => {
    expect(body).toMatch(
      /export const HARNESS_RESERVED_INTENT_NAMES = \['fill_form', 'login', 'search'\] as const;/,
    );
  });

  it('caps + defaults pinned: behavioral_pause 300_000ms, wait_for 300s, scroll 600px/down, wait_for 30s', () => {
    expect(body).toMatch(/export const HARNESS_BEHAVIORAL_PAUSE_CAP_MS = 300_000;/);
    expect(body).toMatch(/export const HARNESS_WAIT_FOR_CAP_SECONDS = 300;/);
    expect(body).toMatch(/export const HARNESS_SCROLL_DEFAULT_DISTANCE_PX = 600;/);
    expect(body).toMatch(/export const HARNESS_SCROLL_DEFAULT_DIRECTION = 'down' as const;/);
    expect(body).toMatch(/export const HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS = 30;/);
  });

  it('caps are NOT pre-clamped by the sender (harness clamps + reports the flag)', () => {
    expect(body).toMatch(
      /The sender passes values through; do NOT pre-clamp \(that\s*\n?\s*\/\/ would suppress the flag the customer should see\)\./,
    );
  });

  it('navigate params pinned: { url } required (.min(1)) + V-820.sec http(s)-only scheme allow-list (refine isHttpOrHttpsUrl rejecting file:/javascript:/data:)', () => {
    expect(body).toMatch(
      /export const NavigateParamsSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*url: z\.string\(\)\.min\(1\)\.refine\(isHttpOrHttpsUrl, \{/,
    );
    expect(body).toMatch(/\}\)\s*\n?\s*\.strict\(\);/);
    // The scheme guard itself: http:/https: only (everything else, + relative, rejected).
    expect(body).toMatch(/function isHttpOrHttpsUrl\(raw: string\): boolean \{/);
    expect(body).toMatch(/return parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:';/);
  });

  it('click params pinned: { element_id } OR { strategy, value } (union, strict)', () => {
    expect(body).toMatch(
      /export const ClickParamsSchema = z\.union\(\[\s*\n?\s*z\.object\(\{ element_id: z\.string\(\)\.min\(1\) \}\)\.strict\(\),\s*\n?\s*z\.object\(\{ strategy: z\.string\(\)\.min\(1\), value: z\.string\(\) \}\)\.strict\(\),\s*\n?\s*\]\);/,
    );
  });

  it('send_keys params pinned: strategy + value + text all required (strict)', () => {
    expect(body).toMatch(
      /export const SendKeysParamsSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*strategy: z\.string\(\)\.min\(1\),\s*\n?\s*value: z\.string\(\),\s*\n?\s*text: z\.string\(\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
  });

  it('scroll params pinned: direction up|down, distance_px int>0, start_x/start_y int — all optional; SDK surfaces direction+distance_px only', () => {
    expect(body).toMatch(/direction: z\.enum\(\['up', 'down'\]\)\.optional\(\),/);
    expect(body).toMatch(/distance_px: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/);
    expect(body).toMatch(/start_x: z\.number\(\)\.int\(\)\.optional\(\),/);
    expect(body).toMatch(/start_y: z\.number\(\)\.int\(\)\.optional\(\),/);
    expect(body).toMatch(
      /SDK surfaces direction \+ distance_px\s*\n?\s*\/\/ ONLY; start_x\/start_y are server\/harness internals/,
    );
  });

  it('behavioral_pause params pinned: { duration_ms } OR { kind:reading, word_count } OR none (idle)', () => {
    expect(body).toMatch(
      /export const BehavioralPauseParamsSchema = z\.union\(\[\s*\n?\s*z\.object\(\{ duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\) \}\)\.strict\(\),\s*\n?\s*z\.object\(\{ kind: z\.literal\('reading'\), word_count: z\.number\(\)\.int\(\)\.nonnegative\(\) \}\)\.strict\(\),\s*\n?\s*NoParamsSchema,\s*\n?\s*\]\);/,
    );
  });

  it('wait_for params pinned: predicate required + timeout_seconds int>0 optional', () => {
    expect(body).toMatch(/predicate: z\.string\(\)\.min\(1\),/);
    expect(body).toMatch(/timeout_seconds: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/);
  });

  it('execute_script params pinned: script required + args unknown[] optional', () => {
    expect(body).toMatch(/script: z\.string\(\)\.min\(1\),/);
    expect(body).toMatch(/args: z\.array\(z\.unknown\(\)\)\.optional\(\),/);
  });

  it('intentName→schema map pinned (all 11 routed)', () => {
    expect(body).toMatch(
      /export const HARNESS_INTENT_PARAM_SCHEMAS: Record<HarnessIntentName, z\.ZodTypeAny> = \{/,
    );
    for (const name of HARNESS_INTENT_NAMES) {
      expect(body).toMatch(new RegExp(`${name}: \\w+Schema,`));
    }
  });

  it('IntentDispatch envelope pinned: type:intentDispatch discriminator + sessionId, intentId, intentName (enum), inputParams (base64 string)', () => {
    expect(body).toMatch(
      /export const IntentDispatchSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('intentDispatch'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*intentId: z\.string\(\)\.min\(1\),\s*\n?\s*intentName: HarnessIntentNameSchema,\s*\n?\s*inputParams: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('IntentResult envelope pinned: type:intentResult discriminator + sessionId, intentId, success, durationMs, outputData? (base64 string), errorCode?, errorMessage?', () => {
    expect(body).toMatch(
      /export const IntentResultEnvelopeSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('intentResult'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*intentId: z\.string\(\)\.min\(1\),\s*\n?\s*success: z\.boolean\(\),\s*\n?\s*durationMs: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*outputData: z\.string\(\)\.optional\(\),\s*\n?\s*errorCode: HarnessErrorCodeSchema\.optional\(\),\s*\n?\s*errorMessage: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('flat {type,…} wire envelope (no _0) pinned + SessionStatus + HarnessOutbound discriminated union (A3 W122 / 2a5639dc)', () => {
    expect(body).toMatch(/FLAT discriminated union keyed on `type`/);
    expect(body).toMatch(/NO `_0` nesting/);
    expect(body).toMatch(
      /export const SessionStatusSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('sessionStatus'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*status: z\.string\(\)\.min\(1\),\s*\n?\s*timestamp: z\.string\(\),\s*\n?\s*detail: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const HarnessOutboundSchema = z\.discriminatedUnion\('type', \[\s*\n?\s*IntentResultEnvelopeSchema,\s*\n?\s*SessionStatusSchema,\s*\n?\s*HeartbeatSchema,\s*\n?\s*CapabilityReportSchema,\s*\n?\s*ErrorEventSchema,\s*\n?\s*\]\);/,
    );
  });

  it('all 5 HarnessOutbound payloads pinned to A3 W124 field-sets (heartbeat/errorEvent/capabilityReport typed, not passthrough)', () => {
    // heartbeat
    expect(body).toMatch(
      /export const HeartbeatSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('heartbeat'\),\s*\n?\s*macNodeId: z\.string\(\),\s*\n?\s*timestamp: z\.string\(\),\s*\n?\s*cpuPercent: z\.number\(\),\s*\n?\s*memoryPercent: z\.number\(\),\s*\n?\s*activeSessionCount: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
    // errorEvent
    expect(body).toMatch(/export const ErrorEventSchema = z\.object\(\{/);
    expect(body).toMatch(/customerActionable: z\.boolean\(\),\s*\n?\s*retryable: z\.boolean\(\),/);
    // capabilityReport (incl. the nested safeguardChecks array)
    expect(body).toMatch(/export const CapabilityReportSchema = z\.object\(\{/);
    expect(body).toMatch(
      /safeguardChecks: z\.array\(\s*\n?\s*z\.object\(\{\s*\n?\s*layer: z\.string\(\),\s*\n?\s*passed: z\.boolean\(\),\s*\n?\s*detail: z\.string\(\)\.optional\(\),\s*\n?\s*timestamp: z\.string\(\),\s*\n?\s*\}\),\s*\n?\s*\),/,
    );
    expect(body).toMatch(/archetypeId: z\.string\(\),/);
  });

  it('behavioral: HarnessOutbound accepts a valid heartbeat + rejects a malformed one (now typed, not passthrough)', () => {
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'heartbeat',
        macNodeId: 'n1',
        timestamp: 't',
        cpuPercent: 12.5,
        memoryPercent: 40,
        activeSessionCount: 3,
      }).success,
    ).toBe(true);
    // missing required fields → rejected (was accepted under passthrough).
    expect(HarnessOutboundSchema.safeParse({ type: 'heartbeat' }).success).toBe(false);
  });

  it('6 error codes pinned in canonical order (runtime exact-order — comment-agnostic; intent_invalid_parameter added A3 W135)', () => {
    // Exact .toEqual (not a source regex): order-sensitive + tolerant of the
    // inline rationale comments now interleaved in the source array.
    expect([...HARNESS_ERROR_CODES]).toEqual([
      'intent_session_not_established',
      'intent_not_implemented',
      'intent_missing_parameter',
      'intent_invalid_parameter',
      'intent_webdriver_failed',
      'intent_dispatch_error',
      'result_too_large',
    ]);
  });
});

describe('harness-control-protocol behavioral contract', () => {
  it('intent vocab + reserved set + error codes match the canonical counts', () => {
    expect(HARNESS_INTENT_NAMES).toHaveLength(11);
    expect(HARNESS_RESERVED_INTENT_NAMES).toEqual(['fill_form', 'login', 'search']);
    expect(HARNESS_ERROR_CODES).toHaveLength(7);
    // The param-schema map covers exactly the dispatchable vocab.
    expect(Object.keys(HARNESS_INTENT_PARAM_SCHEMAS).sort()).toEqual(
      [...HARNESS_INTENT_NAMES].sort(),
    );
  });

  it('A3 W135 — an intentResult carrying errorCode intent_invalid_parameter PARSES (the decode-enum gap: before adding it, IntentResultEnvelopeSchema rejected the frame → the correlator silently dropped it → the dispatch hung to its timeout)', () => {
    expect(HarnessErrorCodeSchema.safeParse('intent_invalid_parameter').success).toBe(true);
    const frame = {
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: false,
      durationMs: 3,
      errorCode: 'intent_invalid_parameter',
      errorMessage: 'navigate.url rejected: non-http(s) scheme',
    };
    expect(IntentResultEnvelopeSchema.safeParse(frame).success).toBe(true);
  });

  it('EG-API-1.6 SessionAssign (A3 W136 shape, W138 optionality): required vs optional fields, transportMode enum, initialUrl http(s)-only, livekit snake_case strict', () => {
    const valid = {
      type: 'sessionAssign',
      sessionId: 'ses_1',
      archetype: 'iphone17_ios18_7_safari26_4',
      behaviorProfile: 'regular',
      transportMode: 'h2-and-h3',
      idleTimeoutSeconds: 300,
      maxDurationSeconds: 3600,
    };
    expect(SessionAssignSchema.safeParse(valid).success).toBe(true);
    // A3 W138 — the MINIMAL valid assign is just type+sessionId+archetype+
    // behaviorProfile; transportMode + the two timeouts are optional (omit →
    // harness defaults).
    expect(
      SessionAssignSchema.safeParse({
        type: 'sessionAssign',
        sessionId: 'ses_1',
        archetype: 'iphone17_ios18_7_safari26_4',
        behaviorProfile: 'regular',
      }).success,
    ).toBe(true);
    // Only sessionId / archetype / behaviorProfile are REQUIRED (no safe default).
    for (const k of ['sessionId', 'archetype', 'behaviorProfile']) {
      const { [k]: _omit, ...rest } = valid as Record<string, unknown>;
      expect(SessionAssignSchema.safeParse(rest).success, `${k} required`).toBe(false);
    }
    // The W138-optional fields may each be omitted without failing.
    for (const k of ['transportMode', 'idleTimeoutSeconds', 'maxDurationSeconds']) {
      const { [k]: _omit, ...rest } = valid as Record<string, unknown>;
      expect(SessionAssignSchema.safeParse(rest).success, `${k} optional`).toBe(true);
    }
    // transportMode (when present) is a closed enum (dash-cased, W118).
    expect(SessionAssignSchema.safeParse({ ...valid, transportMode: 'h2Only' }).success).toBe(
      false,
    );
    // initialUrl http(s)-only (chokepoint guard; A3 W135).
    expect(SessionAssignSchema.safeParse({ ...valid, initialUrl: 'https://ok' }).success).toBe(
      true,
    );
    expect(
      SessionAssignSchema.safeParse({ ...valid, initialUrl: 'file:///etc/passwd' }).success,
    ).toBe(false);
    // livekit is the lone snake_case wire object + strict (rejects camelCase ws_url).
    expect(
      SessionAssignSchema.safeParse({
        ...valid,
        livekit: { room: 'r', token: 't', ws_url: 'wss://x', expires_at: '2026-06-05T20:00:00Z' },
      }).success,
    ).toBe(true);
    expect(
      SessionAssignSchema.safeParse({
        ...valid,
        livekit: { room: 'r', token: 't', wsUrl: 'wss://x', expiresAt: 'z' },
      }).success,
    ).toBe(false);
    // strict envelope: unknown top-level key rejected.
    expect(SessionAssignSchema.safeParse({ ...valid, bogus: 1 }).success).toBe(false);
  });

  it('profile-backed sessions (A3 W417): optional snake_case profile block; profile_id+dek required; blob fields optional; strict', () => {
    const base = {
      type: 'sessionAssign',
      sessionId: 'ses_1',
      archetype: 'iphone16pro_ios18_6_safari18_6',
      behaviorProfile: 'regular',
    };
    // absent profile ⇒ stateless path still valid.
    expect(SessionAssignSchema.safeParse(base).success).toBe(true);
    // inline (≤256KB) shape.
    expect(
      SessionAssignSchema.safeParse({
        ...base,
        profile: { profile_id: 'p1', dek: 'ZGVr', sealed_blob: 'YmxvYg==' },
      }).success,
    ).toBe(true);
    // large shape (presigned GET + PUT).
    expect(
      SessionAssignSchema.safeParse({
        ...base,
        profile: {
          profile_id: 'p1',
          dek: 'ZGVr',
          sealed_blob_url: 'https://r2/get',
          sealed_blob_put_url: 'https://r2/put',
        },
      }).success,
    ).toBe(true);
    // fresh profile (no prior state) ⇒ profile_id + dek only is valid.
    expect(
      SessionAssignSchema.safeParse({ ...base, profile: { profile_id: 'p1', dek: 'ZGVr' } })
        .success,
    ).toBe(true);
    // profile_id + dek REQUIRED.
    for (const k of ['profile_id', 'dek']) {
      const profile: Record<string, unknown> = { profile_id: 'p1', dek: 'ZGVr' };
      delete profile[k];
      expect(SessionAssignSchema.safeParse({ ...base, profile }).success, `${k} required`).toBe(
        false,
      );
    }
    // snake_case only — camelCase key rejected (strict; the silent-nil drift A3 W417 guards).
    expect(
      SessionAssignSchema.safeParse({
        ...base,
        profile: { profile_id: 'p1', dek: 'ZGVr', sealedBlob: 'x' },
      }).success,
    ).toBe(false);
  });

  it('reserved JSBridge intents are NOT in the dispatchable enum', () => {
    for (const reserved of HARNESS_RESERVED_INTENT_NAMES) {
      expect(HarnessIntentNameSchema.safeParse(reserved).success).toBe(false);
    }
  });

  it('caps are the contract values', () => {
    expect(HARNESS_BEHAVIORAL_PAUSE_CAP_MS).toBe(300_000);
    expect(HARNESS_WAIT_FOR_CAP_SECONDS).toBe(300);
    expect(HARNESS_SCROLL_DEFAULT_DISTANCE_PX).toBe(600);
    expect(HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS).toBe(30);
  });

  it('navigate requires a non-empty url', () => {
    expect(NavigateParamsSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(NavigateParamsSchema.safeParse({ url: '' }).success).toBe(false);
    expect(NavigateParamsSchema.safeParse({}).success).toBe(false);
    // strict: rejects extra keys.
    expect(NavigateParamsSchema.safeParse({ url: 'x', extra: 1 }).success).toBe(false);
  });

  it('V-820.sec navigate url is http(s)-only: file:/javascript:/data:/chrome: + relative URLs are rejected (no local-file read or script exec via a navigate the model/customer emits)', () => {
    expect(NavigateParamsSchema.safeParse({ url: 'http://example.com' }).success).toBe(true);
    expect(NavigateParamsSchema.safeParse({ url: 'https://example.com/path?q=1' }).success).toBe(
      true,
    );
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(document.cookie)',
      'data:text/html,<script>1</script>',
      'chrome://settings',
      'about:blank',
      'ftp://host/f',
      '//example.com', // protocol-relative → no scheme → rejected
      '/relative/path', // relative → rejected
      'example.com', // bare host, no scheme → rejected
    ]) {
      expect(NavigateParamsSchema.safeParse({ url }).success, url).toBe(false);
    }
  });

  it('click accepts element_id OR strategy+value, rejects mixing/neither', () => {
    expect(ClickParamsSchema.safeParse({ element_id: 'btn-1' }).success).toBe(true);
    expect(ClickParamsSchema.safeParse({ strategy: 'css', value: '.btn' }).success).toBe(true);
    expect(ClickParamsSchema.safeParse({}).success).toBe(false);
    expect(ClickParamsSchema.safeParse({ strategy: 'css' }).success).toBe(false);
  });

  it('send_keys requires all three fields', () => {
    expect(
      SendKeysParamsSchema.safeParse({ strategy: 'css', value: '#in', text: 'hi' }).success,
    ).toBe(true);
    expect(SendKeysParamsSchema.safeParse({ strategy: 'css', value: '#in' }).success).toBe(false);
  });

  it('scroll: all-optional, direction enum + positive distance', () => {
    expect(ScrollParamsSchema.safeParse({}).success).toBe(true);
    expect(ScrollParamsSchema.safeParse({ direction: 'up', distance_px: 800 }).success).toBe(true);
    expect(ScrollParamsSchema.safeParse({ direction: 'sideways' }).success).toBe(false);
    expect(ScrollParamsSchema.safeParse({ distance_px: -5 }).success).toBe(false);
  });

  it('behavioral_pause: ms OR reading OR idle', () => {
    expect(BehavioralPauseParamsSchema.safeParse({ duration_ms: 1500 }).success).toBe(true);
    expect(
      BehavioralPauseParamsSchema.safeParse({ kind: 'reading', word_count: 120 }).success,
    ).toBe(true);
    expect(BehavioralPauseParamsSchema.safeParse({}).success).toBe(true);
    expect(BehavioralPauseParamsSchema.safeParse({ duration_ms: -1 }).success).toBe(false);
  });

  it('wait_for requires predicate; timeout optional positive int', () => {
    expect(WaitForParamsSchema.safeParse({ predicate: 'document.title' }).success).toBe(true);
    expect(WaitForParamsSchema.safeParse({ predicate: 'x', timeout_seconds: 10 }).success).toBe(
      true,
    );
    expect(WaitForParamsSchema.safeParse({}).success).toBe(false);
    expect(WaitForParamsSchema.safeParse({ predicate: 'x', timeout_seconds: 0 }).success).toBe(
      false,
    );
  });

  it('execute_script requires script; args optional array', () => {
    expect(ExecuteScriptParamsSchema.safeParse({ script: 'return 1' }).success).toBe(true);
    expect(
      ExecuteScriptParamsSchema.safeParse({ script: 'return 1', args: [1, 'a'] }).success,
    ).toBe(true);
    expect(ExecuteScriptParamsSchema.safeParse({}).success).toBe(false);
  });

  it('IntentDispatch envelope validates the 4 fields + intentName enum + base64-string inputParams', () => {
    expect(
      IntentDispatchSchema.safeParse({
        type: 'intentDispatch',
        sessionId: 'ses_x',
        intentId: 'int_1',
        intentName: 'navigate',
        inputParams: Buffer.from('{"url":"https://x"}', 'utf8').toString('base64'),
      }).success,
    ).toBe(true);
    // inputParams must be a string (the base64 wire form), not a raw object.
    expect(
      IntentDispatchSchema.safeParse({
        type: 'intentDispatch',
        sessionId: 'ses_x',
        intentId: 'int_1',
        intentName: 'navigate',
        inputParams: { url: 'https://x' },
      }).success,
    ).toBe(false);
    // Unknown intentName rejected.
    expect(
      IntentDispatchSchema.safeParse({
        type: 'intentDispatch',
        sessionId: 'ses_x',
        intentId: 'int_1',
        intentName: 'teleport',
        inputParams: '',
      }).success,
    ).toBe(false);
  });

  it('IntentResult envelope: success + error variants', () => {
    expect(
      IntentResultEnvelopeSchema.safeParse({
        type: 'intentResult',
        sessionId: 'ses_x',
        intentId: 'int_1',
        success: true,
        durationMs: 42,
        outputData: Buffer.from('{"url":"https://x"}', 'utf8').toString('base64'),
      }).success,
    ).toBe(true);
    const err = IntentResultEnvelopeSchema.safeParse({
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: false,
      durationMs: 0,
      errorCode: 'intent_missing_parameter',
      errorMessage: 'url is required',
    });
    expect(err.success).toBe(true);
    // Unknown error code rejected.
    expect(HarnessErrorCodeSchema.safeParse('boom').success).toBe(false);
  });
});
