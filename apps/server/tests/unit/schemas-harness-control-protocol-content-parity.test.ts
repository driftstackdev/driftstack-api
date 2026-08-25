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
//   • Exact 18-intent live IntentExecutor vocabulary.
//   • Caps/defaults: behavioral_pause 300_000ms, wait_for 300s,
//     scroll default 600px/down, wait_for default 30s.
//   • Per-intent param shapes (navigate/click/send_keys/scroll/
//     behavioral_pause/wait_for/execute_script + no-param intents).
//   • intentName→schema map roster.
//   • IntentDispatch + exclusive IntentResult envelopes + 12 live error codes.
//
// Plus a behavioral block that exercises the schemas (accept/reject)
// so the contract is enforced, not just pinned by regex.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_INTENT_NAMES,
  HARNESS_ERROR_CODES,
  HARNESS_BEHAVIORAL_PAUSE_CAP_MS,
  HARNESS_LOGIN_PRODUCER_DEADLINE_MS,
  HARNESS_SEARCH_PRODUCER_DEADLINE_MS,
  HARNESS_WAIT_FOR_CAP_SECONDS,
  HARNESS_SCROLL_DEFAULT_DISTANCE_PX,
  HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS,
  HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES,
  HARNESS_HEARTBEAT_MAX_OUTCOME_COUNTS,
  HARNESS_HEARTBEAT_OUTCOME_REASON_MAX_LENGTH,
  HARNESS_HEARTBEAT_MAX_SERIALIZED_BYTES,
  HARNESS_HEARTBEAT_MAX_CONCURRENT,
  HARNESS_FRAME_ID_MAX_LENGTH,
  HARNESS_RESULT_ERROR_MAX_LENGTH,
  HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
  HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH,
  HARNESS_ERROR_EVENT_MAX_SERIALIZED_BYTES,
  HARNESS_RESULT_FILENAME_MAX_LENGTH,
  HARNESS_RESULT_MIME_MAX_LENGTH,
  HARNESS_DOWNLOAD_MAX_FILES,
  HARNESS_INTENT_OUTPUT_MAX_BYTES,
  HARNESS_DOWNLOAD_DATA_MAX_BYTES,
  PAGE_STATE_URL_MAX_LENGTH,
  PAGE_STATE_TEXT_MAX_LENGTH,
  PROFILE_SAVED_INLINE_MAX_BYTES,
  PROFILE_SAVED_SIZE_MAX_BYTES,
  HARNESS_INTENT_PARAM_SCHEMAS,
  HARNESS_INTENT_RESULT_SCHEMAS,
  TERMINAL_SESSION_STATUSES,
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
  SessionEndSchema,
  SetCookiesRequestSchema,
  NavigateHistoryRequestSchema,
  TrimProfileRequestSchema,
  HarnessErrorCodeSchema,
  HarnessOutboundSchema,
  CookieSchema,
  CookiesResultSchema,
  base64DecodedByteLength,
} from '../../src/schemas/harness-control-protocol.js';
import { serializeTrimProfile } from '../../src/services/harness-control-codec.js';

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

  it('18 live IntentExecutor names are dispatchable in canonical order', () => {
    expect([...HARNESS_INTENT_NAMES]).toEqual([
      'navigate',
      'back',
      'forward',
      'click',
      'send_keys',
      'press_key',
      'execute_script',
      'detect_challenge',
      'extract',
      'screenshot',
      'get_page_source',
      'perceive',
      'wait_for',
      'scroll',
      'behavioral_pause',
      'fill_form',
      'search',
      'login',
    ]);
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

  it('click params pin element, W3C locator, and coordinate target variants', () => {
    expect(body).toContain('export const ClickParamsSchema = z.union([');
    expect(body).toContain('strategy: HarnessLocatorStrategySchema,');
    expect(body).toContain(
      'z.object({ x: z.number(), y: z.number(), wait_after: WaitAfterSchema }).strict(),',
    );
  });

  it('send_keys params pinned: strategy + value + text required, sensitive optional (strict)', () => {
    expect(body).toContain('export const SendKeysParamsSchema = z');
    expect(body).toContain('text: z.string().max(HARNESS_SEND_KEYS_MAX_CHARS),');
    expect(body).toContain('sensitive: z.boolean().optional(),');
  });

  it('press_key params pinned: key string 1..20 (strict) — A3 W1221, one DOM KeyboardEvent.key on the focused element', () => {
    expect(body).toMatch(
      /export const PressKeyParamsSchema = z\.object\(\{ key: z\.string\(\)\.min\(1\)\.max\(20\) \}\)\.strict\(\);/,
    );
  });

  it('scroll params pin vertical/horizontal directions and amount/start/pause controls', () => {
    expect(body).toContain("direction: z.enum(['up', 'down', 'left', 'right']).optional(),");
    expect(body).toContain('distance_px: z.number().nonnegative().optional(),');
    expect(body).toContain('amount: ScrollAmountSchema.optional(),');
    expect(body).toContain('pause_after_ms: z.number().nonnegative().optional(),');
  });

  it('behavioral_pause params pinned: { duration_ms } OR { kind:reading, word_count, scroll_through? } OR none (idle)', () => {
    // Split into small assertions (each ≤6 \s*\n?\s* groups) to avoid the
    // long-chain parity-regex backtracking hazard now that the reading variant is
    // multi-line (W1223 added the optional scroll_through read-through flag).
    expect(body).toContain('export const BehavioralPauseParamsSchema = z.union([');
    // duration_ms variant (strict, single-line).
    expect(body).toContain('z.object({ duration_ms: z.number().nonnegative() }).strict(),');
    // reading variant — W1223 adds the optional scroll_through (read→scroll→read).
    expect(body).toContain("kind: z.literal('reading'),");
    expect(body).toContain('word_count: z.number().nonnegative(),');
    expect(body).toContain('scroll_through: z.boolean().optional(),');
    // idle variant + union close.
    expect(body).toMatch(/NoParamsSchema,\s*\n?\s*\]\);/);
  });

  it('wait_for pins raw predicate and structured safe-template variants', () => {
    expect(body).toContain('export const WaitForParamsSchema = z.union([');
    expect(body).toContain('predicate: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),');
    expect(body).toContain('for: WaitForStructuredSchema,');
  });

  it('execute_script params pinned: script required + args unknown[] optional', () => {
    expect(body).toContain('script: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),');
    expect(body).toMatch(/args: z\.array\(z\.unknown\(\)\)\.optional\(\),/);
  });

  it('intentName→param and result schema maps cover all 18 live names', () => {
    expect(body).toMatch(
      /export const HARNESS_INTENT_PARAM_SCHEMAS: Record<HarnessIntentName, z\.ZodTypeAny> = \{/,
    );
    for (const name of HARNESS_INTENT_NAMES) {
      expect(body).toMatch(new RegExp(`${name}: \\w+Schema,`));
    }
    expect(Object.keys(HARNESS_INTENT_PARAM_SCHEMAS).sort()).toEqual(
      [...HARNESS_INTENT_NAMES].sort(),
    );
    expect(Object.keys(HARNESS_INTENT_RESULT_SCHEMAS).sort()).toEqual(
      [...HARNESS_INTENT_NAMES].sort(),
    );
  });

  it('IntentDispatch envelope pinned: type:intentDispatch discriminator + sessionId, intentId, intentName (enum), inputParams (base64 string)', () => {
    expect(body).toMatch(
      /export const IntentDispatchSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('intentDispatch'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*intentId: z\.string\(\)\.min\(1\),\s*\n?\s*intentName: HarnessIntentNameSchema,\s*\n?\s*inputParams: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('IntentResult envelopes are an exclusive success/failure union with a cheap routing header', () => {
    expect(body).toContain('export const IntentResultHeaderSchema = z');
    expect(body).toContain(
      "export const IntentResultEnvelopeSchema = z.discriminatedUnion('success', [",
    );
    expect(body).toContain("type: z.literal('intentResult'),");
    expect(body).toContain('sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('intentId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain(
      'durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),',
    );
    expect(body).toMatch(
      /outputData: boundedBase64Schema\(\s*\n?\s*HARNESS_INTENT_OUTPUT_MAX_BASE64_LENGTH,\s*\n?\s*HARNESS_INTENT_OUTPUT_MAX_BYTES,\s*\n?\s*\),/,
    );
    expect(body).toContain('errorCode: HarnessErrorCodeSchema,');
    expect(body).toContain(
      'errorMessage: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),',
    );
  });

  it('flat {type,…} wire envelope (no _0) pinned + SessionStatus + HarnessOutbound tagged union (A3 W122 / 2a5639dc)', () => {
    expect(body).toMatch(/FLAT tagged union keyed on `type`/);
    expect(body).toMatch(/NO `_0` nesting/);
    // SessionStatus shape — toContain fragments (not a closed multi-line regex)
    // so the A3 W2682 inline doc comment between `detail` and `reason` doesn't
    // break the pin (the long-chain regex backtracking hazard / feedback).
    expect(body).toContain('export const SessionStatusSchema = z.object({');
    expect(body).toContain("type: z.literal('sessionStatus'),");
    expect(body).toContain('sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('status: z.string().min(1).max(64),');
    expect(body).toContain('timestamp: z.string().min(1).max(64),');
    // Bounded like every sibling result field — a JWT-authed node must not inject
    // an unbounded string that persists into the customer-facing close reason.
    expect(body).toContain('detail: z.string().max(4096).optional(),');
    // A3 W2682 — the optional snake_case close reason on a terminal frame.
    expect(body).toContain('.regex(/^[a-z][a-z0-9_]{0,127}$/)');
    // A3 W2682 terminal-status vocabulary — the EXACT close-on set (drift-guarded).
    expect(body).toMatch(
      /export const TERMINAL_SESSION_STATUSES = new Set<string>\(\['ended', 'errored'\]\);/,
    );
    expect(body).toMatch(
      /export const HarnessOutboundSchema = z\.union\(\[\s*\n?\s*IntentResultEnvelopeSchema,\s*\n?\s*SessionStatusSchema,\s*\n?\s*HeartbeatSchema,\s*\n?\s*CapabilityReportSchema,\s*\n?\s*ErrorEventSchema,\s*\n?\s*ProfileSavedSchema,\s*\n?\s*ChallengeDetectedSchema,\s*\n?\s*PageStateFrameSchema,\s*\n?\s*ProfileSaveFailedSchema,\s*\n?\s*CookiesResultSchema,\s*\n?\s*SetCookiesResultSchema,\s*\n?\s*NavigateHistoryResultSchema,\s*\n?\s*UploadResultSchema,\s*\n?\s*DownloadsListResultSchema,\s*\n?\s*DownloadDataResultSchema,\s*\n?\s*TrimProfileResultSchema,\s*\n?\s*\]\);/,
    );
    // ControlInbound.sessionEnd — the trivial W122 teardown envelope (source-pinned).
    expect(body).toMatch(
      /export const SessionEndSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\.literal\('sessionEnd'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
  });

  it('cookie-import frames pinned: setCookies (CP→node, strict, reuses CookieSchema) + setCookiesResult (node→CP, in union)', () => {
    // CP→node REQUEST — strict, carries the jar as z.array(CookieSchema) (no
    // divergent Cookie shape — the import is the write-twin of the read).
    expect(body).toMatch(
      /export const SetCookiesRequestSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\.literal\('setCookies'\),\s*\n?\s*requestId: z\.string\(\)\.min\(1\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*cookies: z\.array\(CookieSchema\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
    // node→CP RESULT — ok?/error?, lenient forward-compat like cookiesResult.
    expect(body).toContain('export const SetCookiesResultSchema = z.object({');
    expect(body).toContain("type: z.literal('setCookiesResult'),");
    expect(body).toContain('requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),');
  });

  it('history-navigation frames pinned: navigateHistory (CP→node, strict, direction enum back|forward, optional tabId) + navigateHistoryResult (node→CP, in union)', () => {
    // CP→node REQUEST — strict, carries the closed direction enum (the sibling of
    // setCookies; the only two history steps) + an optional tabId (multi-tab
    // forward-compat, gated-inert until A3's harness reads it).
    // toContain fragments (not a closed multi-line regex) so the tabId field +
    // its rationale comment don't break the pin.
    expect(body).toContain('export const NavigateHistoryRequestSchema = z');
    expect(body).toContain('.object({');
    expect(body).toContain("type: z.literal('navigateHistory'),");
    expect(body).toContain('requestId: z.string().min(1),');
    expect(body).toContain("direction: z.enum(['back', 'forward']),");
    expect(body).toContain('tabId: z.string().optional(),');
    // node→CP RESULT — ok?/error?, lenient forward-compat like setCookiesResult.
    expect(body).toContain('export const NavigateHistoryResultSchema = z.object({');
    expect(body).toContain("type: z.literal('navigateHistoryResult'),");
    expect(body).toContain('requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),');
  });

  it('profile-trim frames pinned: trimProfile (CP→node, strict, JIT crypto envelope) + trimResult (node→CP, in union)', () => {
    // CP→node REQUEST — strict, carries the JIT crypto envelope (dek + presigned
    // GET/PUT) keyed by profile_id (OUT-OF-SESSION, no sessionId); the payload fields
    // are snake_case (profile_id / sealed_blob / sealed_blob_url / sealed_blob_put_url)
    // mirroring SessionAssign.ProfileInfo — only type + requestId stay camelCase (the
    // CP→node envelope convention). sealed_blob_put_url REQUIRED, one of
    // sealed_blob/sealed_blob_url supplies the input.
    expect(body).toMatch(
      /export const TrimProfileRequestSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\.literal\('trimProfile'\),\s*\n?\s*requestId: z\.string\(\)\.min\(1\),\s*\n?\s*profile_id: z\.string\(\)\.min\(1\),\s*\n?\s*dek: z\.string\(\)\.min\(1\),\s*\n?\s*sealed_blob: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*sealed_blob_url: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*sealed_blob_put_url: z\.string\(\)\.min\(1\),/,
    );
    // W3120 — the scope rides as an OPTIONAL enum. Pinned separately from the
    // block above so its optionality is visible as its own assertion: absent
    // means 'cache', which is what the op did before the field existed, and
    // that is the property an older node depends on.
    expect(body).toMatch(
      /scope: z\.enum\(\['cache', 'cookies', 'history', 'all'\]\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
    // node→CP RESULT — ok?/newSizeBytes?/bytesReclaimed?/error?, lenient like cookiesResult.
    expect(body).toContain('export const TrimProfileResultSchema = z.object({');
    expect(body).toContain("type: z.literal('trimResult'),");
    expect(body).toContain('profileId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain(
      'newSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),',
    );
    expect(body).toContain(
      'bytesReclaimed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),',
    );
    expect(body).toContain('error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),');
  });

  it('trimProfile WIRE keys are snake_case (A3-root-caused regression: camelCase broke the box Codable decode → trim never ran)', () => {
    // CONTENT-parity, not just a source regex: serialize a real trim envelope (camelCase
    // args in) and assert the emitted WIRE object carries the exact snake_case payload
    // keys the harness Swift Codable decoder requires. The correlator unit tests use a
    // mock transport and never inspected casing, so they missed the prod break where
    // serializeTrimProfile emitted profileId/sealedBlob* → DecodingError.keyNotFound
    // 'profile_id'. This is the regression net for that casing.
    const wire = serializeTrimProfile({
      requestId: 'rq_1',
      profileId: 'prof_x',
      dek: 'ZGVrLWJhc2U2NA==',
      sealedBlobURL: 'https://r2/get?sig=1',
      sealedBlobPutURL: 'https://r2/put?sig=1',
    });
    // The payload fields cross the wire snake_case (mirroring SessionAssign.ProfileInfo).
    expect(wire).toEqual({
      type: 'trimProfile',
      requestId: 'rq_1',
      profile_id: 'prof_x',
      dek: 'ZGVrLWJhc2U2NA==',
      sealed_blob_url: 'https://r2/get?sig=1',
      sealed_blob_put_url: 'https://r2/put?sig=1',
    });
    // Exact key set — assert the snake_case keys are present and NONE of the old
    // camelCase payload keys leaked back (the precise shape that broke the box).
    expect(Object.keys(wire).sort()).toEqual(
      ['dek', 'profile_id', 'requestId', 'sealed_blob_url', 'sealed_blob_put_url', 'type'].sort(),
    );
    for (const camel of ['profileId', 'sealedBlob', 'sealedBlobURL', 'sealedBlobPutURL']) {
      expect(Object.prototype.hasOwnProperty.call(wire, camel)).toBe(false);
    }
    // The schema itself rejects a stray camelCase payload key (strict guards the drift).
    expect(
      TrimProfileRequestSchema.safeParse({
        type: 'trimProfile',
        requestId: 'rq_1',
        profileId: 'prof_x', // camelCase — must be rejected by .strict()
        dek: 'ZGVrLWJhc2U2NA==',
        sealed_blob_put_url: 'https://r2/put?sig=1',
      }).success,
    ).toBe(false);
    // And the inline sealed_blob variant likewise snake-cases.
    const inlineWire = serializeTrimProfile({
      requestId: 'rq_2',
      profileId: 'prof_y',
      dek: 'ZGVr',
      sealedBlob: 'YmxvYg==',
      sealedBlobPutURL: 'https://r2/put?sig=2',
    });
    expect(inlineWire).toMatchObject({ sealed_blob: 'YmxvYg==' });
    expect(Object.prototype.hasOwnProperty.call(inlineWire, 'sealedBlob')).toBe(false);
  });

  it('W393 challenge-handling contract: pauseSession/resumeSession inbound (strict) + challengeDetected outbound (in union) + behavioral parse', () => {
    // ControlInbound.pauseSession / resumeSession (server → harness, strict).
    expect(body).toMatch(
      /export const PauseSessionSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\.literal\('pauseSession'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
    expect(body).toMatch(
      /export const ResumeSessionSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\.literal\('resumeSession'\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*challengeId: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
    // HarnessOutbound.challengeDetected (harness → server) — shape pinned.
    // toContain fragments (not a closed multi-line regex) so the security-audit
    // hardening comment (2026-06-30, .max() bounds on type/detail) doesn't
    // break the pin.
    expect(body).toContain('export const ChallengeDetectedSchema = z.object({');
    expect(body).toContain("type: z.literal('challengeDetected'),");
    expect(body).toContain('sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('challengeId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('challenge: z.object({');
    expect(body).toContain('type: z.string().max(256),');
    expect(body).toContain('detail: z.string().max(4096).optional(),');
    // challengeDetected parses through the outbound union; challengeId required.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'challengeDetected',
        sessionId: 's1',
        challengeId: 'chl_1',
        challenge: { type: 'datadome', confidence: 0.9 },
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'challengeDetected',
        sessionId: 's1',
        challenge: { type: 'datadome', confidence: 0.9 },
      }).success,
    ).toBe(false); // missing challengeId
  });

  it('profileSaved (A3 W417 + doc-150 item 5) pinned to the outbound union + shape (sessionId camelCase + profile_id/sealed_blob snake_case + stored + size_bytes optional)', () => {
    expect(body).toContain('export const ProfileSavedSchema = z');
    expect(body).toContain('sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('profile_id: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('stored: z.literal(true).optional(),');
    expect(body).toContain(
      'size_bytes: z.number().int().nonnegative().max(PROFILE_SAVED_SIZE_MAX_BYTES)',
    );
    // inline + large shapes both parse via the union; sessionId required.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        sealed_blob: 'YmxvYg==',
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        stored: true,
      }).success,
    ).toBe(true);
    // doc-150 item 5 — a frame carrying size_bytes parses (both shapes).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        stored: true,
        size_bytes: 9_000_000_000,
      }).success,
    ).toBe(true);
    // a negative size_bytes is rejected (nonnegative).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        sealed_blob: 'YmxvYg==',
        size_bytes: -1,
      }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({ type: 'profileSaved', profile_id: 'p1' }).success,
    ).toBe(false);
    // Exact transport shape: inline XOR stored:true. Neither, both, and false
    // acknowledgements must not reach persistence or stamp last_saved_at.
    for (const invalid of [
      { type: 'profileSaved', sessionId: 's1', profile_id: 'p1' },
      {
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        sealed_blob: 'YmxvYg==',
        stored: true,
      },
      { type: 'profileSaved', sessionId: 's1', profile_id: 'p1', stored: false },
    ]) {
      expect(HarnessOutboundSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        sealed_blob: Buffer.alloc(PROFILE_SAVED_INLINE_MAX_BYTES).toString('base64'),
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        sealed_blob: Buffer.alloc(PROFILE_SAVED_INLINE_MAX_BYTES + 1).toString('base64'),
      }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'profileSaved',
        sessionId: 's1',
        profile_id: 'p1',
        stored: true,
        size_bytes: PROFILE_SAVED_SIZE_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it('pageState (A3 W2730 wire spec) pinned to the outbound union + the RELAXED shape (Swift encodeIfPresent OMITS nil keys): url/title/error all optional, kind lenient, http_status optional+null-only. The previous REQUIRED url/error/http_status dropped EVERY real frame at safeParse → empty store → no live URL', () => {
    // Shape pinned via toContain fragments (NOT a closed multi-line regex — the
    // schema now carries comments + prettier may reflow it). Key relaxations:
    expect(body).toContain('export const PageStateFrameSchema = z.object({');
    expect(body).toContain("type: z.literal('pageState'),");
    expect(body).toContain("state: z.enum(['loading', 'loaded', 'errored', 'stalled']),");
    expect(body).toContain('url: z.string().max(PAGE_STATE_URL_MAX_LENGTH).nullable().optional(),');
    expect(body).toContain(
      'title: z.string().max(PAGE_STATE_TEXT_MAX_LENGTH).nullable().optional(),',
    );
    // Forward-compat per-tab attribution (A3 contract pending) — optional so a
    // frame without it still validates + is carried as null downstream.
    expect(body).toContain('tabId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),');
    expect(body).toContain('kind: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('http_status: z.null().optional(),');
    // The exact A3 W2730 wire shapes must ALL parse (these are what the box sends):
    // loading: url present, NO error key.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'loading',
        url: 'https://example.com',
      }).success,
    ).toBe(true);
    // loaded: url + title, NO error key.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'loaded',
        url: 'https://example.com/landed',
        title: 'Example Domain',
      }).success,
    ).toBe(true);
    // reload: url OMITTED entirely (encodeIfPresent).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'loading',
      }).success,
    ).toBe(true);
    // errored: nested {kind, message} WITHOUT http_status (never emitted, W1222).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'errored',
        url: 'https://example.com',
        error: { kind: 'net', message: 'connection refused' },
      }).success,
    ).toBe(true);
    // kind is lenient now (was net|timeout only) so a frame is NEVER dropped on an
    // unexpected kind (earlier docs listed http|tls|dns).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'errored',
        error: { kind: 'tls', message: 'x' },
      }).success,
    ).toBe(true);
    // stalled (A3 W2845): a frozen-but-alive renderer — url present, NO error.
    // Was rejected by the closed enum before the add → frame silently dropped.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'stalled',
        url: 'https://example.com/app',
      }).success,
    ).toBe(true);
    // http_status, if ever present, must be null — a numeric status is rejected.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'errored',
        error: { kind: 'net', http_status: 404, message: 'x' },
      }).success,
    ).toBe(false);
    // title-only change frame on a NON-loaded state (the box may emit `title` on
    // ANY state, e.g. an in-page document.title update with no navigation) — must
    // validate so the GUI poll can self-heal the address-bar title.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'loading',
        title: 'Renamed Tab',
      }).success,
    ).toBe(true);
    // tabId (forward-compat per-tab attribution) — present validates …
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'loaded',
        url: 'https://example.com',
        tabId: 'tab_2',
      }).success,
    ).toBe(true);
    // … and a frame WITHOUT it still validates (optional → backward-compatible).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'pageState',
        sessionId: 'agt_1',
        state: 'loaded',
        url: 'https://example.com',
      }).success,
    ).toBe(true);
    for (const oversized of [
      { sessionId: 's'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1) },
      { url: 'u'.repeat(PAGE_STATE_URL_MAX_LENGTH + 1) },
      { title: 't'.repeat(PAGE_STATE_TEXT_MAX_LENGTH + 1) },
      { tabId: 't'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1) },
      {
        error: {
          kind: 'k'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1),
          message: 'm'.repeat(PAGE_STATE_TEXT_MAX_LENGTH + 1),
        },
      },
    ]) {
      expect(
        HarnessOutboundSchema.safeParse({
          type: 'pageState',
          sessionId: 'agt_1',
          state: 'loaded',
          ...oversized,
        }).success,
      ).toBe(false);
    }
  });

  it('all 6 HarnessOutbound payloads pinned to A3 W124 field-sets (heartbeat/errorEvent/capabilityReport typed, not passthrough)', () => {
    // heartbeat — the A3 W124 base field-set (toContain fragments, not a
    // closed multi-line regex, so prettier reflow + the optional fleet
    // additions below don't break the pin).
    expect(body).toContain('const HeartbeatPayloadSchema = z.object({');
    expect(body).toContain(
      'export const HeartbeatSchema = HeartbeatPayloadSchema.transform((frame, ctx) => {',
    );
    expect(body).toContain("type: z.literal('heartbeat'),");
    expect(body).toContain('macNodeId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),');
    expect(body).toContain('cpuPercent: HeartbeatPercentSchema,');
    expect(body).toContain('memoryPercent: HeartbeatPercentSchema,');
    expect(body).toMatch(
      /activeSessionCount: z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(HARNESS_HEARTBEAT_MAX_CONCURRENT\),/,
    );
    // …extended with the fleet-admin-panel telemetry (file-48 §A5; A3
    // W2189/W2197/W2199*), all OPTIONAL so an older node's beat still decodes;
    // field names mirror the Swift Codable Heartbeat 1:1 (else stripped).
    expect(body).toMatch(
      /maxConcurrent: z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(HARNESS_HEARTBEAT_MAX_CONCURRENT\)\.optional\(\),/,
    );
    expect(body).toContain(
      'uptimeSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),',
    );
    expect(body).toContain("drainState: z.literal('draining').optional(),");
    expect(body).toContain('sessionOutcomeCounts: HeartbeatOutcomeCountsSchema.optional(),');
    // Per-session liveness re-base (A2 W2679 / A3 driftstack f52699c37) — the
    // {agentSessionId → state} map the SessionLivenessStore reads. OPTIONAL +
    // omit-when-nil so an older node's beat still decodes byte-identically.
    expect(body).toContain("z.enum(['active', 'provisioning', 'idle', 'terminating']),");
    expect(body).toContain(
      "thermalState: z.enum(['nominal', 'fair', 'serious', 'critical']).optional(),",
    );
    expect(body).toContain(
      "memoryPressureLevel: z.enum(['normal', 'warn', 'critical']).optional(),",
    );
    expect(body).toContain('busiestCorePercent: HeartbeatPercentSchema.optional(),');
    expect(body).toContain('diskFreePercent: HeartbeatPercentSchema.optional(),');
    expect(body).toContain(
      'harnessVersion: z.string().max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),',
    );
    // errorEvent
    expect(body).toContain('const ErrorEventPayloadSchema = z.object({');
    expect(body).toContain(
      'export const ErrorEventSchema = ErrorEventPayloadSchema.transform((frame, ctx) => {',
    );
    expect(body).toMatch(/customerActionable: z\.boolean\(\),\s*\n?\s*retryable: z\.boolean\(\),/);
    // capabilityReport — bounded payload + the three live customer signals the
    // harness emits (these used to be stripped, making the whole channel inert).
    expect(body).toContain('const CapabilityReportPayloadSchema = z.object({');
    expect(body).toContain(
      'export const CapabilityReportSchema = CapabilityReportPayloadSchema.transform((frame, ctx) => {',
    );
    expect(body).toContain('safeguardChecks: z');
    expect(body).toContain('.max(16),');
    expect(body).toContain('detail: z.string().max(4096).optional(),');
    expect(body).toContain('manualInputAvailable: z.boolean().optional(),');
    expect(body).toContain(
      "streamingState: z.enum(['provisioning', 'live', 'blank', 'failed']).optional(),",
    );
    expect(body).toContain("egressState: z.enum(['live', 'dead_proxy']).optional(),");
    // Derived, not quoted. The size used to appear twice — `> 64 * 1024` in
    // the check and a hardcoded "65536" in the message beside it — the same
    // shape as the upload-cap messages that drifted. Both now read the one
    // constant, so this pins the LINK rather than the number.
    expect(body).toContain('export const CAPABILITY_REPORT_MAX_BYTES = 64 * 1024;');
    expect(body).toContain(
      "if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > CAPABILITY_REPORT_MAX_BYTES) {",
    );
    expect(body).toContain(
      'message: `capabilityReport must serialize to at most ${CAPABILITY_REPORT_MAX_BYTES} bytes`,',
    );
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

  it('behavioral: capabilityReport preserves live health signals and rejects invalid or oversized values', () => {
    const valid = {
      type: 'capabilityReport' as const,
      sessionId: 'agt_1',
      timestamp: '2026-07-13T06:00:00.000Z',
      egressPhase: 'phase_1_socks5',
      proxyKind: 'socks5',
      proxyUdpSupported: true,
      proxyIpv4Supported: true,
      proxyIpv6Supported: false,
      transportModeRequested: 'h2-and-h3',
      transportModeActive: 'h2-only',
      h3InterposeLoaded: false,
      httpsSkipActive: true,
      safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
      archetypeId: 'iphone16pro_ios18_6_safari18_6',
      manualInputAvailable: false,
      streamingState: 'blank',
      egressState: 'dead_proxy',
    };
    const parsed = HarnessOutboundSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'capabilityReport') {
      expect(parsed.data).toMatchObject({
        manualInputAvailable: false,
        streamingState: 'blank',
        egressState: 'dead_proxy',
      });
    }
    expect(
      HarnessOutboundSchema.safeParse({ ...valid, streamingState: 'looks-fine' }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        ...valid,
        safeguardChecks: Array.from({ length: 17 }, (_, i) => ({
          layer: `layer-${i}`,
          passed: true,
          timestamp: 't',
        })),
      }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        ...valid,
        safeguardChecks: [
          { layer: 'dns', passed: false, timestamp: 't', detail: 'x'.repeat(65_536) },
        ],
      }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        ...valid,
        safeguardChecks: Array.from({ length: 16 }, (_, i) => ({
          layer: `layer-${i}`,
          passed: false,
          timestamp: 't',
          detail: 'x'.repeat(4096),
        })),
      }).success,
    ).toBe(false);
  });

  it('behavioral: errorEvent preserves the real producer shape but rejects oversized, malformed, and open severity values', () => {
    const valid = {
      type: 'errorEvent' as const,
      sessionId: 'agt_1',
      timestamp: '2026-07-13T06:00:00.000Z',
      code: 'proxy_connection_failed',
      severity: 'error',
      summary: 'The configured proxy could not be reached.',
      detail: 'Connection timed out.',
      customerActionable: true,
      retryable: true,
    };
    expect(HarnessOutboundSchema.safeParse(valid).success).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({ ...valid, summary: 'x'.repeat(8 * 1024 * 1024) }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        ...valid,
        summary: 's'.repeat(HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH),
        detail: 'd'.repeat(HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH),
      }).success,
    ).toBe(false);
    expect(HARNESS_ERROR_EVENT_MAX_SERIALIZED_BYTES).toBe(20 * 1024);
    expect(HarnessOutboundSchema.safeParse({ ...valid, severity: 'critical' }).success).toBe(false);
    expect(HarnessOutboundSchema.safeParse({ ...valid, code: 'Proxy failed now' }).success).toBe(
      false,
    );
    expect(HarnessOutboundSchema.safeParse({ ...valid, sessionId: 'x'.repeat(257) }).success).toBe(
      false,
    );
  });

  it('fleet-admin telemetry fields decode through (no longer stripped) — file-48 §A5 / A3 W2189-W2199', () => {
    const parsed = HarnessOutboundSchema.safeParse({
      type: 'heartbeat',
      macNodeId: 'n1',
      timestamp: 't',
      cpuPercent: 12.5,
      memoryPercent: 40,
      activeSessionCount: 3,
      maxConcurrent: 8,
      uptimeSeconds: 1234.5,
      drainState: 'draining',
      sessionOutcomeCounts: { idle_timeout: 5, browser_crashed: 2 },
      activeSessionStates: { agt_a: 'active', agt_b: 'provisioning', agt_c: 'terminating' },
      thermalState: 'fair',
      memoryPressureLevel: 'normal',
      busiestCorePercent: 73.2,
      diskFreePercent: 41.8,
      harnessVersion: 'abc1234',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'heartbeat') {
      // The previously-stripped fields now survive decode.
      expect(parsed.data.maxConcurrent).toBe(8);
      expect(parsed.data.uptimeSeconds).toBe(1234.5);
      expect(parsed.data.drainState).toBe('draining');
      expect(parsed.data.sessionOutcomeCounts).toEqual({ idle_timeout: 5, browser_crashed: 2 });
      // Per-session liveness map survives decode (was previously .strip()ped);
      // activeSessionCount is the scalar count of these entries.
      expect(parsed.data.activeSessionStates).toEqual({
        agt_a: 'active',
        agt_b: 'provisioning',
        agt_c: 'terminating',
      });
      expect(parsed.data.thermalState).toBe('fair');
      expect(parsed.data.busiestCorePercent).toBe(73.2);
      expect(parsed.data.diskFreePercent).toBe(41.8);
      expect(parsed.data.harnessVersion).toBe('abc1234');
    }
    // An unrecognized liveness state is rejected (the enum is closed) so a
    // producer drift surfaces instead of silently passing through.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'heartbeat',
        macNodeId: 'n1',
        timestamp: 't',
        cpuPercent: 1,
        memoryPercent: 1,
        activeSessionCount: 1,
        activeSessionStates: { agt_a: 'bogus' },
      }).success,
    ).toBe(false);
    // A quiet/older node (none of the optionals) still decodes — byte-identical contract.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'heartbeat',
        macNodeId: 'n1',
        timestamp: 't',
        cpuPercent: 1,
        memoryPercent: 1,
        activeSessionCount: 0,
      }).success,
    ).toBe(true);
  });

  it('12 live error codes are pinned in canonical order', () => {
    // Exact .toEqual (not a source regex): order-sensitive + tolerant of the
    // inline rationale comments now interleaved in the source array.
    expect([...HARNESS_ERROR_CODES]).toEqual([
      'intent_session_not_established',
      'intent_not_implemented',
      'intent_missing_parameter',
      'intent_invalid_parameter',
      'intent_webdriver_failed',
      'intent_script_failed',
      'intent_dispatch_error',
      'intent_deadline_exceeded',
      'intent_deadline_cleanup_unconfirmed',
      'result_too_large',
      'session_paused',
      'session_intent_in_flight',
    ]);
  });
});

describe('harness-control-protocol behavioral contract', () => {
  it('intent vocab, strict schema maps, and error codes match canonical counts', () => {
    expect(HARNESS_INTENT_NAMES).toHaveLength(18);
    expect(HARNESS_ERROR_CODES).toHaveLength(12);
    expect(Object.keys(HARNESS_INTENT_PARAM_SCHEMAS).sort()).toEqual(
      [...HARNESS_INTENT_NAMES].sort(),
    );
    expect(Object.keys(HARNESS_INTENT_RESULT_SCHEMAS).sort()).toEqual(
      [...HARNESS_INTENT_NAMES].sort(),
    );
  });

  it('all 18 live parameter and success-result shapes validate against their correlated maps', () => {
    const params: Record<(typeof HARNESS_INTENT_NAMES)[number], unknown> = {
      navigate: { url: 'https://example.com' },
      back: {},
      forward: {},
      click: { x: 12, y: 34 },
      send_keys: { strategy: 'css selector', value: '#q', text: 'hello' },
      press_key: { key: 'Enter' },
      execute_script: { script: 'return arguments[0]', args: [1] },
      detect_challenge: {},
      extract: { extractions: [{ name: 'title', selector: 'h1', type: 'text' }] },
      screenshot: { format: 'png' },
      get_page_source: {},
      perceive: { max_elements: 25 },
      wait_for: { for: { selector: '.ready', appears: true }, timeout_seconds: 5 },
      scroll: { direction: 'right', amount: { pixels: 120 } },
      behavioral_pause: { kind: 'decision' },
      fill_form: { fields: [{ selector: '#email', value: 'a@example.com' }] },
      search: { query: 'driftstack' },
      login: { username: 'user', password: 'pass' },
    };
    const results: Record<(typeof HARNESS_INTENT_NAMES)[number], unknown> = {
      navigate: { url: 'https://example.com' },
      back: { url: 'https://example.com/a', action: 'back' },
      forward: { url: 'https://example.com/b', action: 'forward' },
      click: { clicked: 'coords', behavioral: true, activated: null },
      send_keys: { typed_into: 'el_1', length: 5, truncated: false, behavioral: true },
      press_key: { pressed: 'Enter' },
      execute_script: { value: null },
      detect_challenge: { challenge_detected: false },
      extract: { value: { title: 'Example' } },
      screenshot: {
        screenshot_b64: 'aGk=',
        format: 'png',
        full_page: false,
        annotated: false,
      },
      get_page_source: { source: '<html></html>', truncated: false },
      perceive: {
        value: {
          url: 'https://example.com',
          title: 'Example',
          elements: [],
          truncated: false,
          total_matched: 0,
        },
      },
      wait_for: { waited: true, timeout_capped: false },
      scroll: {
        scrolled: -120,
        requested: -120,
        scrolled_measured: true,
        flicks: 1,
        steps: 8,
        behavioral: true,
        distance_capped: false,
      },
      behavioral_pause: { paused_ms: 500, capped: false, behavioral: true },
      fill_form: { fields_filled: 1, submitted: false, truncated: false },
      search: { submitted: true, query_truncated: false },
      login: {
        submitted: true,
        credentials_truncated: false,
        logged_in: true,
        post_login_url: 'https://example.com/account',
      },
    };
    for (const name of HARNESS_INTENT_NAMES) {
      expect(HARNESS_INTENT_PARAM_SCHEMAS[name].safeParse(params[name]).success, name).toBe(true);
      expect(HARNESS_INTENT_RESULT_SCHEMAS[name].safeParse(results[name]).success, name).toBe(true);
    }
    expect(HARNESS_INTENT_RESULT_SCHEMAS.navigate.safeParse({ pressed: 'Enter' }).success).toBe(
      false,
    );
    expect(
      HARNESS_INTENT_RESULT_SCHEMAS.back.safeParse({
        url: 'https://example.com',
        action: 'forward',
      }).success,
    ).toBe(false);
    expect(
      HARNESS_INTENT_RESULT_SCHEMAS.fill_form.safeParse({
        fields_filled: 1,
        submitted: false,
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it('login result is an exact submitted-or-safe-truncation union with a 600s producer owner', () => {
    expect(HARNESS_LOGIN_PRODUCER_DEADLINE_MS).toBe(600_000);
    const schema = HARNESS_INTENT_RESULT_SCHEMAS.login;
    for (const valid of [
      {
        submitted: true,
        credentials_truncated: false,
        logged_in: true,
        post_login_url: 'https://example.com/account',
      },
      { submitted: true, credentials_truncated: false, logged_in: false },
      { submitted: false, credentials_truncated: true, logged_in: false },
    ]) {
      expect(schema.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
    }

    for (const invalid of [
      { logged_in: true, credentials_truncated: false },
      { submitted: true, credentials_truncated: true, logged_in: false },
      { submitted: false, credentials_truncated: false, logged_in: false },
      { submitted: false, credentials_truncated: true, logged_in: true },
      {
        submitted: false,
        credentials_truncated: true,
        logged_in: false,
        post_login_url: 'https://example.com/account',
      },
      {
        submitted: false,
        credentials_truncated: true,
        logged_in: false,
        username: 'must-never-return',
      },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('fill_form result is an exact complete-or-safe-truncation union', () => {
    const schema = HARNESS_INTENT_RESULT_SCHEMAS.fill_form;
    for (const valid of [
      { fields_filled: 1, submitted: false, truncated: false },
      { fields_filled: 50, submitted: true, truncated: false },
      { fields_filled: 0, submitted: false, truncated: true, truncated_fields: [0] },
      { fields_filled: 49, submitted: false, truncated: true, truncated_fields: [49] },
    ]) {
      expect(schema.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
    }
    for (const invalid of [
      { fields_filled: 0, submitted: false, truncated: false },
      { fields_filled: 51, submitted: false, truncated: false },
      { fields_filled: 1, submitted: false, truncated: false, truncated_fields: [1] },
      { fields_filled: 0, submitted: true, truncated: true, truncated_fields: [0] },
      { fields_filled: 1, submitted: false, truncated: true, truncated_fields: [0] },
      { fields_filled: 1, submitted: false, truncated: true, truncated_fields: [1, 2] },
      { fields_filled: 50, submitted: false, truncated: true, truncated_fields: [50] },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('search result is an exact normal-or-zero-submit truncation union with a 600s owner', () => {
    expect(HARNESS_SEARCH_PRODUCER_DEADLINE_MS).toBe(600_000);
    const schema = HARNESS_INTENT_RESULT_SCHEMAS.search;
    for (const valid of [
      { submitted: true, query_truncated: false, results_visible: true },
      { submitted: false, query_truncated: false },
      { submitted: false, query_truncated: true },
    ]) {
      expect(schema.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
    }
    for (const invalid of [
      { submitted: true, query_truncated: true },
      { submitted: false, query_truncated: true, results_visible: false },
      { submitted: false, query_truncated: false, query: 'must-never-return' },
      { submitted: false },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('every live failure code is accepted by the exclusive failure envelope', () => {
    for (const errorCode of HARNESS_ERROR_CODES) {
      expect(
        IntentResultEnvelopeSchema.safeParse({
          type: 'intentResult',
          sessionId: 'ses_x',
          intentId: 'int_1',
          success: false,
          durationMs: 1,
          errorCode,
        }).success,
        errorCode,
      ).toBe(true);
    }
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
    // geolocation override (A3 verdict 2026-07-01) — optional; bounded lat/lon,
    // optional positive accuracy, strict (no extra keys). Absent → auto-derive.
    expect(
      SessionAssignSchema.safeParse({
        ...valid,
        geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 20 },
      }).success,
    ).toBe(true);
    expect(
      SessionAssignSchema.safeParse({ ...valid, geolocation: { latitude: 0, longitude: 0 } })
        .success,
    ).toBe(true);
    expect(
      SessionAssignSchema.safeParse({ ...valid, geolocation: { latitude: 91, longitude: 0 } })
        .success,
    ).toBe(false);
    expect(
      SessionAssignSchema.safeParse({ ...valid, geolocation: { latitude: 0, longitude: 181 } })
        .success,
    ).toBe(false);
    expect(
      SessionAssignSchema.safeParse({
        ...valid,
        geolocation: { latitude: 0, longitude: 0, accuracy: -1 },
      }).success,
    ).toBe(false);
    expect(
      SessionAssignSchema.safeParse({
        ...valid,
        geolocation: { latitude: 0, longitude: 0, bogus: 1 },
      }).success,
    ).toBe(false);
    // strict envelope: unknown top-level key rejected.
    expect(SessionAssignSchema.safeParse({ ...valid, bogus: 1 }).success).toBe(false);
  });

  it('sessionEnd (ControlInbound teardown): trivial {type,sessionId} envelope, strict', () => {
    expect(SessionEndSchema.safeParse({ type: 'sessionEnd', sessionId: 'agt_1' }).success).toBe(
      true,
    );
    expect(SessionEndSchema.safeParse({ type: 'sessionEnd', sessionId: '' }).success).toBe(false);
    expect(SessionEndSchema.safeParse({ type: 'sessionEnd' }).success).toBe(false);
    // strict: no stray fields (would silently diverge from the harness decoder).
    expect(
      SessionEndSchema.safeParse({ type: 'sessionEnd', sessionId: 'agt_1', reason: 'x' }).success,
    ).toBe(false);
  });

  it('cookie-import behavioral: setCookies (CP→node) strict + jar reuses CookieSchema; setCookiesResult parses through the outbound union', () => {
    // CP→node setCookies — requires type/requestId/sessionId/cookies; cookies is the
    // shared CookieSchema (a read/Export jar round-trips 1:1).
    const jar = [
      {
        domain: '.example.com',
        name: 'sid',
        value: 'abc',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      { domain: 'example.com', name: 'pref', value: 'dark' },
    ];
    expect(
      SetCookiesRequestSchema.safeParse({
        type: 'setCookies',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        cookies: jar,
      }).success,
    ).toBe(true);
    // missing cookies → rejected; strict envelope rejects a stray key.
    expect(
      SetCookiesRequestSchema.safeParse({
        type: 'setCookies',
        requestId: 'rq_1',
        sessionId: 'agt_1',
      }).success,
    ).toBe(false);
    expect(
      SetCookiesRequestSchema.safeParse({
        type: 'setCookies',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        cookies: jar,
        bogus: 1,
      }).success,
    ).toBe(false);
    // a cookie missing the required value → rejected (shares CookieSchema).
    expect(
      SetCookiesRequestSchema.safeParse({
        type: 'setCookies',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        cookies: [{ domain: 'x', name: 'y' }],
      }).success,
    ).toBe(false);
    // node→CP setCookiesResult parses through the outbound union (ok + error shapes).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'setCookiesResult',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        ok: true,
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'setCookiesResult',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        error: 'session not found',
      }).success,
    ).toBe(true);
    // requestId required.
    expect(
      HarnessOutboundSchema.safeParse({ type: 'setCookiesResult', sessionId: 'agt_1', ok: true })
        .success,
    ).toBe(false);
  });

  it('history-navigation behavioral: navigateHistory (CP→node) strict + direction enum back|forward; navigateHistoryResult parses through the outbound union', () => {
    // CP→node navigateHistory — requires type/requestId/sessionId/direction.
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'back',
      }).success,
    ).toBe(true);
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'forward',
      }).success,
    ).toBe(true);
    // direction is a CLOSED enum — anything else is rejected.
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'sideways',
      }).success,
    ).toBe(false);
    // missing direction → rejected; strict envelope rejects a stray key.
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
      }).success,
    ).toBe(false);
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'back',
        bogus: 1,
      }).success,
    ).toBe(false);
    // node→CP navigateHistoryResult parses through the outbound union (ok + error shapes).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'navigateHistoryResult',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        ok: true,
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'navigateHistoryResult',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        error: 'no entry in that direction',
      }).success,
    ).toBe(true);
    // requestId required.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'navigateHistoryResult',
        sessionId: 'agt_1',
        ok: true,
      }).success,
    ).toBe(false);
  });

  it('navigateHistory.tabId is optional (multi-tab forward-compat) — accepted when present, absent still validates, non-string rejected', () => {
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'back',
        tabId: 'tab_2',
      }).success,
    ).toBe(true);
    // Omitted — unchanged from the pre-tabId behavior (targets the current tab).
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'back',
      }).success,
    ).toBe(true);
    expect(
      NavigateHistoryRequestSchema.safeParse({
        type: 'navigateHistory',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        direction: 'back',
        tabId: 123,
      }).success,
    ).toBe(false);
  });

  it('A3 W2682 TERMINAL_SESSION_STATUSES is EXACTLY {ended, errored} (drift-guard — a mismatch silently no-ops the worker-connected close)', () => {
    // Runtime membership (order-agnostic Set) — the close contract.
    expect([...TERMINAL_SESSION_STATUSES].sort()).toEqual(['ended', 'errored']);
    expect(TERMINAL_SESSION_STATUSES.size).toBe(2);
    expect(TERMINAL_SESSION_STATUSES.has('ended')).toBe(true);
    expect(TERMINAL_SESSION_STATUSES.has('errored')).toBe(true);
    // A3 confirmed there is NO terminated/closed/crashed — those must NOT match.
    for (const notTerminal of [
      'terminated',
      'closed',
      'crashed',
      'active',
      'idle',
      'provisioning',
    ]) {
      expect(TERMINAL_SESSION_STATUSES.has(notTerminal)).toBe(false);
    }
  });

  it('SessionStatus carries an optional snake_case reason (A3 W2682) — present on a terminal frame, omittable on a non-terminal one', () => {
    // terminal ended/errored frame with a clean reason parses.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: 'idle_timeout',
      }).success,
    ).toBe(true);
    // a non-terminal frame may omit reason (today's shape).
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'active',
        timestamp: 't',
      }).success,
    ).toBe(true);
    // reason, when present, must be a non-empty string.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: '',
      }).success,
    ).toBe(false);
  });

  it('SessionStatus reason is a bounded snake_case token and detail is bounded', () => {
    const base = { type: 'sessionStatus', sessionId: 'agt_a', status: 'ended', timestamp: 't' };
    expect(HarnessOutboundSchema.safeParse({ ...base, reason: 'x'.repeat(128) }).success).toBe(
      true,
    );
    expect(HarnessOutboundSchema.safeParse({ ...base, reason: 'x'.repeat(129) }).success).toBe(
      false,
    );
    for (const reason of ['browser crashed', 'browser_crashed direct=10.0.0.8', '<b>oops</b>']) {
      expect(HarnessOutboundSchema.safeParse({ ...base, reason }).success).toBe(false);
    }
    // detail bounded at 4096 (matches every sibling detail in this file).
    expect(HarnessOutboundSchema.safeParse({ ...base, detail: 'x'.repeat(4096) }).success).toBe(
      true,
    );
    expect(HarnessOutboundSchema.safeParse({ ...base, detail: 'x'.repeat(4097) }).success).toBe(
      false,
    );
    for (const oversized of [
      { sessionId: 's'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1) },
      { status: 's'.repeat(65) },
      { timestamp: 't'.repeat(65) },
    ]) {
      expect(HarnessOutboundSchema.safeParse({ ...base, ...oversized }).success).toBe(false);
    }
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

  it('formerly omitted live handlers are accepted by the dispatchable enum', () => {
    for (const name of [
      'detect_challenge',
      'extract',
      'perceive',
      'fill_form',
      'search',
      'login',
    ]) {
      expect(HarnessIntentNameSchema.safeParse(name).success).toBe(true);
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
    expect(ClickParamsSchema.safeParse({ strategy: 'css selector', value: '.btn' }).success).toBe(
      true,
    );
    expect(ClickParamsSchema.safeParse({ x: 12.5, y: 44 }).success).toBe(true);
    expect(ClickParamsSchema.safeParse({}).success).toBe(false);
    expect(ClickParamsSchema.safeParse({ strategy: 'css selector' }).success).toBe(false);
    expect(ClickParamsSchema.safeParse({ strategy: 'css', value: '.btn' }).success).toBe(false);
  });

  it('send_keys requires locator/text and accepts optional sensitive only', () => {
    expect(
      SendKeysParamsSchema.safeParse({ strategy: 'css selector', value: '#in', text: 'hi' })
        .success,
    ).toBe(true);
    expect(
      SendKeysParamsSchema.safeParse({
        strategy: 'css selector',
        value: '#password',
        text: 'secret',
        sensitive: true,
      }).success,
    ).toBe(true);
    expect(SendKeysParamsSchema.safeParse({ strategy: 'css selector', value: '#in' }).success).toBe(
      false,
    );
    expect(
      SendKeysParamsSchema.safeParse({
        strategy: 'css selector',
        value: '#in',
        text: 'hi',
        sensitive: 'true',
      }).success,
    ).toBe(false);
  });

  it('scroll: all-optional, full direction enum + nonnegative distance and amount', () => {
    expect(ScrollParamsSchema.safeParse({}).success).toBe(true);
    expect(ScrollParamsSchema.safeParse({ direction: 'up', distance_px: 800 }).success).toBe(true);
    expect(ScrollParamsSchema.safeParse({ direction: 'right', amount: 'one_screen' }).success).toBe(
      true,
    );
    expect(ScrollParamsSchema.safeParse({ amount: { pixels: 0 } }).success).toBe(true);
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

  it('wait_for requires a predicate or structured safe-template condition', () => {
    expect(WaitForParamsSchema.safeParse({ predicate: 'document.title' }).success).toBe(true);
    expect(WaitForParamsSchema.safeParse({ predicate: 'x', timeout_seconds: 10 }).success).toBe(
      true,
    );
    expect(WaitForParamsSchema.safeParse({ for: { selector: '.ready' } }).success).toBe(true);
    expect(WaitForParamsSchema.safeParse({ for: { seconds: 0.5 } }).success).toBe(true);
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
    const success = {
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: true,
      durationMs: 42,
      outputData: Buffer.from('{"url":"https://x"}', 'utf8').toString('base64'),
    };
    const failure = {
      type: 'intentResult',
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: false,
      durationMs: 0,
      errorCode: 'intent_missing_parameter',
      errorMessage: 'url is required',
    };
    expect(IntentResultEnvelopeSchema.safeParse(success).success).toBe(true);
    expect(IntentResultEnvelopeSchema.safeParse(failure).success).toBe(true);
    // Success must carry output and no error; failure must carry errorCode and
    // no output. This prevents contradictory envelopes entering the correlator.
    const { outputData: _outputData, ...successMissingOutput } = success;
    expect(IntentResultEnvelopeSchema.safeParse(successMissingOutput).success).toBe(false);
    expect(
      IntentResultEnvelopeSchema.safeParse({ ...success, errorCode: 'intent_dispatch_error' })
        .success,
    ).toBe(false);
    const { errorCode: _errorCode, ...failureMissingCode } = failure;
    expect(IntentResultEnvelopeSchema.safeParse(failureMissingCode).success).toBe(false);
    expect(
      IntentResultEnvelopeSchema.safeParse({ ...failure, outputData: success.outputData }).success,
    ).toBe(false);
    // Unknown error code rejected.
    expect(HarnessErrorCodeSchema.safeParse('boom').success).toBe(false);
  });

  // Security-audit hardening (2026-06-30) — 4 missing-length-bound findings.
  it('Heartbeat.activeSessionStates is capped at HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES entries — a node fabricating more can no longer poison the process-wide SessionLivenessStore via an oversized single beat', () => {
    const withinCap: Record<string, 'active'> = {};
    for (let i = 0; i < HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES; i++) {
      withinCap[`agt_${i}`] = 'active';
    }
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'heartbeat',
        macNodeId: 'n1',
        timestamp: 't',
        cpuPercent: 1,
        memoryPercent: 1,
        activeSessionCount: HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES,
        activeSessionStates: withinCap,
      }).success,
    ).toBe(true);
    const overCap: Record<string, 'active'> = { ...withinCap, agt_over: 'active' };
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'heartbeat',
        macNodeId: 'n1',
        timestamp: 't',
        cpuPercent: 1,
        memoryPercent: 1,
        activeSessionCount: HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES + 1,
        activeSessionStates: overCap,
      }).success,
    ).toBe(false);
  });

  it('Heartbeat persisted/liveness telemetry is producer-bounded per field and in aggregate before consumers run', () => {
    const base = {
      type: 'heartbeat' as const,
      macNodeId: 'mac-macstadium-us-001',
      timestamp: '2026-07-13T09:20:00.000Z',
      cpuPercent: 25,
      memoryPercent: 50,
      activeSessionCount: 1,
    };
    const outcomesAtCap = Object.fromEntries(
      Array.from({ length: HARNESS_HEARTBEAT_MAX_OUTCOME_COUNTS }, (_, i) => [`reason_${i}`, i]),
    );

    expect(
      HarnessOutboundSchema.safeParse({
        ...base,
        maxConcurrent: HARNESS_HEARTBEAT_MAX_CONCURRENT,
        uptimeSeconds: Number.MAX_SAFE_INTEGER,
        drainState: 'draining',
        sessionOutcomeCounts: outcomesAtCap,
        activeSessionStates: { agt_1: 'active' },
        thermalState: 'nominal',
        memoryPressureLevel: 'normal',
        busiestCorePercent: 100,
        diskFreePercent: 0,
        harnessVersion: 'h'.repeat(HARNESS_FRAME_ID_MAX_LENGTH),
      }).success,
    ).toBe(true);

    const oversizedOutcomes = {
      ...outcomesAtCap,
      reason_over: 1,
    };
    const invalidFields: Record<string, unknown>[] = [
      { harnessVersion: 'h'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1) },
      { sessionOutcomeCounts: oversizedOutcomes },
      {
        sessionOutcomeCounts: {
          ['r'.repeat(HARNESS_HEARTBEAT_OUTCOME_REASON_MAX_LENGTH + 1)]: 1,
        },
      },
      {
        activeSessionStates: {
          ['a'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1)]: 'active',
        },
      },
      { activeSessionCount: HARNESS_HEARTBEAT_MAX_CONCURRENT + 1 },
      { maxConcurrent: HARNESS_HEARTBEAT_MAX_CONCURRENT + 1 },
      { cpuPercent: -1 },
      { memoryPercent: 101 },
      { busiestCorePercent: Number.NaN },
      { diskFreePercent: 101 },
      { drainState: 'serving' },
      { thermalState: 'hot' },
      { memoryPressureLevel: 'unknown' },
    ];
    for (const invalid of invalidFields) {
      expect(HarnessOutboundSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }

    // Every individual key and the entry count remain valid; only the composed
    // canonical heartbeat exceeds the persistence/liveness payload budget.
    const aggregateStates: Record<string, 'active'> = {};
    for (let i = 0; i < 300; i++) {
      aggregateStates[`agt_${i}_${'x'.repeat(220)}`] = 'active';
    }
    const aggregate = {
      ...base,
      activeSessionCount: 300,
      activeSessionStates: aggregateStates,
    };
    expect(Buffer.byteLength(JSON.stringify(aggregate), 'utf8')).toBeGreaterThan(
      HARNESS_HEARTBEAT_MAX_SERIALIZED_BYTES,
    );
    expect(HarnessOutboundSchema.safeParse(aggregate).success).toBe(false);
  });

  it('ChallengeDetectedSchema.challenge.type/.detail are bounded — an oversized value (webhook storage/bandwidth amplification via challenge-relay.ts) is rejected', () => {
    const base = {
      type: 'challengeDetected' as const,
      sessionId: 'agt_1',
      challengeId: 'chl_1',
    };
    expect(
      HarnessOutboundSchema.safeParse({
        ...base,
        challenge: { type: 'datadome', confidence: 0.9, detail: 'x'.repeat(4096) },
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        ...base,
        challenge: { type: 'datadome', confidence: 0.9, detail: 'x'.repeat(4097) },
      }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        ...base,
        challenge: { type: 'x'.repeat(257), confidence: 0.9 },
      }).success,
    ).toBe(false);
    expect(
      HarnessOutboundSchema.safeParse({
        ...base,
        challengeId: 'c'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1),
        challenge: { type: 'datadome', confidence: 0.9 },
      }).success,
    ).toBe(false);
  });

  it('ProfileSaveFailedSchema.detail is bounded — an oversized value (webhook storage/bandwidth amplification via profile-save-failed-relay.ts) is rejected', () => {
    const base = {
      type: 'profileSaveFailed' as const,
      sessionId: 'agt_1',
      profile_id: 'p1',
      reason: 'upload_failed' as const,
    };
    expect(HarnessOutboundSchema.safeParse({ ...base, detail: 'x'.repeat(4096) }).success).toBe(
      true,
    );
    expect(HarnessOutboundSchema.safeParse({ ...base, detail: 'x'.repeat(4097) }).success).toBe(
      false,
    );
    for (const oversized of [
      { sessionId: 's'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1) },
      { profile_id: 'p'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1) },
    ]) {
      expect(HarnessOutboundSchema.safeParse({ ...base, ...oversized }).success).toBe(false);
    }
    const superseded = HarnessOutboundSchema.parse({ ...base, reason: 'superseded' });
    expect(superseded).toMatchObject({ reason: 'superseded' });
    const futureReason = HarnessOutboundSchema.parse({ ...base, reason: 'future_reason' });
    expect(futureReason).toMatchObject({ reason: 'upload_failed' });
  });

  it('CookieSchema domain/name/value/path are bounded (RFC 6265-realistic) — reused by both the customer write-path (SetCookiesRequestSchema) and the harness read-path (CookiesResultSchema); an ~oversized field on either is rejected', () => {
    const okCookie = {
      domain: 'x'.repeat(512),
      name: 'y'.repeat(512),
      value: 'z'.repeat(4096),
      path: '/'.repeat(512),
    };
    expect(CookieSchema.safeParse(okCookie).success).toBe(true);
    expect(CookieSchema.safeParse({ ...okCookie, domain: 'x'.repeat(513) }).success).toBe(false);
    expect(CookieSchema.safeParse({ ...okCookie, name: 'y'.repeat(513) }).success).toBe(false);
    expect(CookieSchema.safeParse({ ...okCookie, value: 'z'.repeat(4097) }).success).toBe(false);
    expect(CookieSchema.safeParse({ ...okCookie, path: '/'.repeat(513) }).success).toBe(false);
    // Write path (SetCookiesRequestSchema) rejects an oversized cookie value too.
    expect(
      SetCookiesRequestSchema.safeParse({
        type: 'setCookies',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        cookies: [{ domain: 'd', name: 'n', value: 'z'.repeat(4097) }],
      }).success,
    ).toBe(false);
  });

  it('CookiesResultSchema.cookies is capped at 2000 (matches the customer-facing write-path SetCookiesBodySchema) — a compromised/malformed harness node returning more is rejected', () => {
    const jar2000 = Array.from({ length: 2000 }, (_, i) => ({
      domain: 'x.com',
      name: `c${i}`,
      value: 'v',
    }));
    expect(
      CookiesResultSchema.safeParse({
        type: 'cookiesResult',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        cookies: jar2000,
      }).success,
    ).toBe(true);
    const jar2001 = [...jar2000, { domain: 'x.com', name: 'over', value: 'v' }];
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'cookiesResult',
        requestId: 'rq_1',
        sessionId: 'agt_1',
        cookies: jar2001,
      }).success,
    ).toBe(false);
  });

  // V-1396 — the alphabet rejection had never run. `base64DecodedByteLength` is the strict
  // half of the harness wire: arithmetic-only, so an oversized payload is refused without
  // allocating a decoded copy of it. Its three rejection points are NOT equally reachable,
  // and the existing arm below reaches only the first.
  //
  //   length % 4      — covered: `'***'` is three characters, so it is refused here and the
  //                     alphabet loop underneath is never entered.
  //   alphabet loop   — NEVER RAN. Nothing had passed a length-valid string containing a
  //                     character outside `[A-Za-z0-9+/]`.
  //   padding loop    — UNREACHABLE. `padding` is derived from the trailing `=` test, so the
  //                     region it scans contains only `=` by construction. Brute-forced over
  //                     all 4096 four-character strings from an alphabet mixing letters,
  //                     digits, `+`, `/`, `*` and `=`: the padding loop rejects nothing, ever.
  //
  // This matters because of what sits downstream. `decodeWireData` on the codec side is
  // deliberately permissive — Node drops characters outside the alphabet and keeps the rest
  // (V-1382) — so this schema is the layer that refuses a malformed payload rather than
  // silently delivering a truncated one to the harness.
  it('CRITICAL a length-valid string containing a non-alphabet character is refused, which is the rejection the existing three-character case never reaches. The codec below this decodes permissively, so if the schema stops refusing, a payload with stray bytes is delivered truncated rather than rejected.', () => {
    for (const bad of ['A*AA', '$$$$', '====', 'AA=A', 'A=B=', '-_-_', 'AAA A']) {
      expect(base64DecodedByteLength(bad), `${bad} must not decode`).toBeNull();
    }
    // The length check needs its own case made of LEGAL characters. `'***'` above is
    // length-invalid AND alphabet-invalid, so the alphabet loop answers it either way —
    // measured, removing the `% 4` guard leaves that arm green. Without the guard these
    // return a FRACTIONAL byte count (`'AAA'` → 2.25), which is then compared against an
    // integer byte bound.
    for (const badLength of ['A', 'Ab', 'AAA', 'AAAAA']) {
      expect(
        base64DecodedByteLength(badLength),
        `${badLength} is not a whole number of base64 quads`,
      ).toBeNull();
    }

    // Control: the same length, entirely inside the alphabet, still decodes.
    expect(base64DecodedByteLength('AbC9'), 'a canonical quad still decodes').toBe(3);
    expect(
      base64DecodedByteLength('+/+/'),
      'the + and / members of the alphabet are accepted',
    ).toBe(3);
  });

  it('CRITICAL the accepted set is EXACTLY canonical base64, checked against an independent oracle over every four-character string from a mixed alphabet. A hand-picked list of bad inputs cannot show that nothing else slips through; this can, and it is what pins the padding loop as redundant rather than merely untested.', () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const SAMPLE = 'ABz9+/=*';

    /** Canonical per RFC 4648, written from the spec rather than from the implementation. */
    const canonical = (v: string): boolean => {
      const trailing = /=*$/.exec(v)?.[0].length ?? 0;
      if (trailing > 2) return false;
      const data = v.slice(0, v.length - trailing);
      return [...data].every((ch) => ALPHABET.includes(ch));
    };

    let checked = 0;
    for (const a of SAMPLE)
      for (const b of SAMPLE)
        for (const c of SAMPLE)
          for (const d of SAMPLE) {
            const v = a + b + c + d;
            checked += 1;
            const got = base64DecodedByteLength(v);
            if (canonical(v)) {
              expect(got, `${v} is canonical and must decode`).not.toBeNull();
            } else {
              expect(got, `${v} is not canonical and must be refused`).toBeNull();
            }
          }
    expect(checked, 'the sweep must actually have run').toBe(SAMPLE.length ** 4);
  });

  it('correlated result frames enforce producer byte limits plus bounded ids, errors, arrays, and file metadata before settling API requests', () => {
    expect(base64DecodedByteLength('')).toBe(0);
    expect(base64DecodedByteLength('AA==')).toBe(1);
    expect(base64DecodedByteLength('AAE=')).toBe(2);
    expect(base64DecodedByteLength('AAEC')).toBe(3);
    expect(base64DecodedByteLength('***')).toBeNull();

    const validIntentOutput = Buffer.from(JSON.stringify({ ok: true }), 'utf8').toString('base64');
    expect(
      IntentResultEnvelopeSchema.safeParse({
        type: 'intentResult',
        sessionId: 'agt_1',
        intentId: 'int_1',
        success: true,
        durationMs: 1,
        outputData: validIntentOutput,
      }).success,
    ).toBe(true);
    const oversizedIntentOutput = Buffer.alloc(HARNESS_INTENT_OUTPUT_MAX_BYTES + 1).toString(
      'base64',
    );
    expect(
      IntentResultEnvelopeSchema.safeParse({
        type: 'intentResult',
        sessionId: 'agt_1',
        intentId: 'int_1',
        success: true,
        durationMs: 1,
        outputData: oversizedIntentOutput,
      }).success,
    ).toBe(false);

    const filesAtCap = Array.from({ length: HARNESS_DOWNLOAD_MAX_FILES }, (_, i) => ({
      name: `file-${i}.txt`,
      size: i,
      mime: 'text/plain',
    }));
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'downloadsList',
        requestId: 'req_1',
        sessionId: 'agt_1',
        files: filesAtCap,
      }).success,
    ).toBe(true);
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'downloadsList',
        requestId: 'req_1',
        sessionId: 'agt_1',
        files: [...filesAtCap, { name: 'over.txt', size: 1 }],
      }).success,
    ).toBe(false);

    // Empty downloads are legitimate; malformed base64 and oversized returned
    // metadata are not. The 64 MiB decoded ceiling is pinned without allocating
    // an 85 MiB encoded fixture in every unit-test run.
    expect(
      HarnessOutboundSchema.safeParse({
        type: 'downloadData',
        requestId: 'req_1',
        sessionId: 'agt_1',
        name: 'empty.txt',
        mime: 'text/plain',
        dataB64: '',
      }).success,
    ).toBe(true);
    for (const invalid of [
      { dataB64: '***' },
      { name: 'n'.repeat(HARNESS_RESULT_FILENAME_MAX_LENGTH + 1) },
      { mime: 'm'.repeat(HARNESS_RESULT_MIME_MAX_LENGTH + 1) },
      { error: 'e'.repeat(HARNESS_RESULT_ERROR_MAX_LENGTH + 1) },
    ]) {
      expect(
        HarnessOutboundSchema.safeParse({
          type: 'downloadData',
          requestId: 'req_1',
          sessionId: 'agt_1',
          name: 'file.txt',
          ...invalid,
        }).success,
      ).toBe(false);
    }
    expect(HARNESS_DOWNLOAD_DATA_MAX_BYTES).toBe(64 * 1024 * 1024);

    const oversizedId = 'i'.repeat(HARNESS_FRAME_ID_MAX_LENGTH + 1);
    const resultFrames = [
      { type: 'cookiesResult', requestId: oversizedId, sessionId: 'agt_1', cookies: [] },
      { type: 'setCookiesResult', requestId: oversizedId, sessionId: 'agt_1', ok: true },
      { type: 'navigateHistoryResult', requestId: oversizedId, sessionId: 'agt_1', ok: true },
      { type: 'uploadResult', requestId: oversizedId, sessionId: 'agt_1' },
      { type: 'downloadsList', requestId: oversizedId, sessionId: 'agt_1', files: [] },
      {
        type: 'downloadData',
        requestId: oversizedId,
        sessionId: 'agt_1',
        name: 'f',
      },
      { type: 'trimResult', requestId: oversizedId, profileId: 'prof_1', ok: true },
    ];
    for (const frame of resultFrames) {
      expect(HarnessOutboundSchema.safeParse(frame).success).toBe(false);
    }
  });
});

// Forward-compat leniency is a property of the harness→server direction, and
// nothing enforced it.
//
// The frames the harness sends are plain `z.object({...})` on purpose: A3 owns
// the wire and adds fields to it (`tabId` is in the schema right now labelled
// "forward-compat plumbing — A3 contract pending"). A plain object strips keys
// it does not model, so a frame carrying a field this server has never heard of
// still validates and still gets handled.
//
// Make one of them `.strict()` and that inverts: every frame carrying the new
// field fails safeParse and is dropped whole. The schema's own comment records
// what that looked like the last time it happened — required url/error/
// http_status "failed safeParse on EVERY real frame → it was silently dropped →
// the page-state store stayed empty → no live URL in the GUI". Nothing errors,
// nothing retries; the GUI just stops knowing where the page is.
//
// Measured before writing this: adding `.strict()` to PageStateFrameSchema
// leaves the entire suite green. The parity arm above pins the shape with
// `toContain` fragments over the source, and `.strict()` changes none of them —
// it appends to the closing paren. The wire-shape safeParse calls beside it all
// use modelled keys, so they cannot see it either.
//
// The rule is NOT "harness frames are lenient" — that was the first draft of
// this block and enumerating the frames disproved it. `intentResult` is
// deliberately `.strict()` on both envelopes: it is a tight contract carrying a
// bounded base64 payload, and its cheap routing header is a separate
// `.passthrough()` schema. So the policy is per-frame, and it is pinned per
// frame below. A blanket check would have had to be wrong in one direction or
// the other.
//
// Both directions are worth catching. A lenient frame turning strict drops
// frames the box already sends. The strict envelope turning lenient silently
// widens a contract whose whole point is that the payload is bounded.
//
// Two things about the enumeration itself, both learned by getting them wrong:
// `intentResult` is a discriminatedUnion, so the modes live one level below the
// union member, and several frames are ZodEffects wrappers with no mode of their
// own. Read either without unwrapping and the answer is `undefined`, which a
// filter looking for 'strict' treats exactly like 'lenient' — the frames with
// the most structure attached would have been the ones silently exempted. That
// is what the "actually READ" arm is for.
describe('harness→server frame strictness is pinned per frame', () => {
  interface ObjectDef {
    readonly _def?: {
      readonly unknownKeys?: string;
      readonly schema?: unknown;
      readonly innerType?: unknown;
    };
    readonly shape?: { readonly type?: { readonly _def?: { readonly value?: unknown } } };
  }
  /**
   * Flattens a union member down to the object schemas that actually carry an
   * unknown-key mode. Two wrappers sit in the way and both would otherwise read
   * as `undefined` — which is indistinguishable from "lenient" to a filter
   * looking for 'strict', so the frames with the most structure attached would
   * be the ones silently exempted:
   *
   *   ZodEffects        `.superRefine` puts the object under `_def.schema`.
   *   nested unions     `intentResult` is a discriminatedUnion of two envelopes,
   *                     so the leaves are one level further down.
   */
  const leaves = (s: unknown, depth = 0): ObjectDef[] => {
    const cur = s as ObjectDef & { readonly _def?: { readonly options?: readonly unknown[] } };
    if (depth > 6 || cur === undefined || cur === null) return [];
    if (cur.shape !== undefined) return [cur];
    const nested = cur._def?.options;
    if (nested !== undefined) return nested.flatMap((o) => leaves(o, depth + 1));
    const inner = cur._def?.schema ?? cur._def?.innerType;
    return inner === undefined ? [cur] : leaves(inner, depth + 1);
  };
  const frameName = (s: ObjectDef, i: number): string => {
    const literal = s.shape?.type?._def?.value;
    return typeof literal === 'string' ? literal : `leaf[${String(i)}]`;
  };
  const outboundLeaves = (): ObjectDef[] => HarnessOutboundSchema.options.flatMap((o) => leaves(o));

  it('CRITICAL the outbound union enumerated a real population', () => {
    // Without this a broken enumeration turns both arms below into a pass over
    // an empty list.
    expect(
      outboundLeaves().length,
      'the harness outbound union enumerated empty',
    ).toBeGreaterThanOrEqual(12);
  });

  it('CRITICAL the strictness of every frame was actually READ', () => {
    // The instrument needs checking too. `unwrap` walks ZodEffects wrappers to
    // find the object underneath; if it ever stops finding it, `unknownKeys`
    // comes back undefined, the "is it strict" filter matches nothing, and the
    // arm below passes for exactly the wrong reason — a guard reporting all
    // clear because it read nothing at all.
    const unread = outboundLeaves()
      .map((leaf, i) => ({ name: frameName(leaf, i), mode: leaf._def?.unknownKeys }))
      .filter((f) => f.mode !== 'strip' && f.mode !== 'strict' && f.mode !== 'passthrough')
      .map((f) => f.name);
    expect(
      unread,
      'the unknown-key mode could not be resolved for a frame, so the leniency check below is ' +
        'silently exempting it rather than testing it',
    ).toEqual([]);
  });

  it('CRITICAL every harness→server frame carries the unknown-key mode it was given', () => {
    // `intentResult` appears twice — the success and failure envelopes of its
    // discriminated union, both strict.
    const EXPECTED: Readonly<Record<string, string>> = {
      intentResult: 'strict', // tight contract, bounded base64 payload
      sessionStatus: 'strip',
      heartbeat: 'strip',
      capabilityReport: 'strip',
      errorEvent: 'strip',
      profileSaved: 'strip',
      challengeDetected: 'strip',
      pageState: 'strip',
      profileSaveFailed: 'strip',
      cookiesResult: 'strip',
      setCookiesResult: 'strip',
      navigateHistoryResult: 'strip',
      uploadResult: 'strip',
      downloadsList: 'strip',
      downloadData: 'strip',
      trimResult: 'strip',
    };
    const actual = outboundLeaves().map((leaf, i) => ({
      name: frameName(leaf, i),
      mode: String(leaf._def?.unknownKeys),
    }));

    const unlisted = actual.filter((f) => EXPECTED[f.name] === undefined).map((f) => f.name);
    expect(
      unlisted,
      'a harness→server frame is not listed here, so whether it tolerates an unknown key was ' +
        'never decided. Add it with the mode you intend: `strip` if the box owns the field set ' +
        'and may add to it, `strict` if this is a bounded contract',
    ).toEqual([]);

    const wrong = actual
      .filter((f) => EXPECTED[f.name] !== undefined && f.mode !== EXPECTED[f.name])
      .map((f) => `${f.name}: expected ${String(EXPECTED[f.name])}, got ${f.mode}`);
    expect(
      wrong,
      'a frame changed its unknown-key mode. Lenient→strict means every frame carrying a field ' +
        'this server does not model now fails safeParse and is dropped whole, with nothing ' +
        'erroring and nothing retrying — the empty page-state store and missing live URL this ' +
        'schema already carries a comment about. Strict→lenient silently widens a contract whose ' +
        'point is that the payload is bounded',
    ).toEqual([]);
  });

  it('CRITICAL a real wire frame carrying an unmodelled field still parses', () => {
    // Ties the structural check to observable behaviour: a structural check
    // alone would pass if the union stopped being consulted.
    const withFutureField = {
      type: 'pageState',
      sessionId: 'agt_1',
      state: 'loaded',
      url: 'https://example.com/landed',
      title: 'Example Domain',
      viewportScrollY: 1280,
    };
    expect(
      HarnessOutboundSchema.safeParse(withFutureField).success,
      'a pageState frame carrying a field this server does not model was rejected outright',
    ).toBe(true);
  });

  it('CRITICAL the CP→node request frames the server constructs stay strict', () => {
    // The other half of the rule. Without this arm, "make everything lenient"
    // would satisfy the check above while quietly widening the frames we build
    // ourselves, where an unknown key means a bug on this side, not forward
    // compatibility.
    const serverBuilt: ReadonlyArray<readonly [string, unknown]> = [
      ['SetCookiesRequestSchema', SetCookiesRequestSchema],
      ['NavigateHistoryRequestSchema', NavigateHistoryRequestSchema],
      ['TrimProfileRequestSchema', TrimProfileRequestSchema],
    ];
    const lenient = serverBuilt
      .filter(([, schema]) => leaves(schema).some((l) => l._def?.unknownKeys !== 'strict'))
      .map(([name]) => name);
    expect(
      lenient,
      'a CP→node request frame stopped rejecting unknown keys. These are built by this server, so ' +
        'an unrecognised key is our own bug and should fail loudly rather than be stripped',
    ).toEqual([]);
  });
});
