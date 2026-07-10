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
  HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES,
  HARNESS_INTENT_PARAM_SCHEMAS,
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

  it('12-intent dispatchable vocab pinned in canonical order (press_key added A3 W1221, after send_keys)', () => {
    expect(body).toMatch(
      /export const HARNESS_INTENT_NAMES = \[\s*\n?\s*'navigate',\s*\n?\s*'back',\s*\n?\s*'forward',\s*\n?\s*'click',\s*\n?\s*'send_keys',\s*\n?\s*'press_key',\s*\n?\s*'scroll',\s*\n?\s*'behavioral_pause',\s*\n?\s*'wait_for',\s*\n?\s*'execute_script',\s*\n?\s*'screenshot',\s*\n?\s*'get_page_source',\s*\n?\s*\] as const;/,
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

  it('press_key params pinned: key string 1..20 (strict) — A3 W1221, one DOM KeyboardEvent.key on the focused element', () => {
    expect(body).toMatch(
      /export const PressKeyParamsSchema = z\.object\(\{ key: z\.string\(\)\.min\(1\)\.max\(20\) \}\)\.strict\(\);/,
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

  it('behavioral_pause params pinned: { duration_ms } OR { kind:reading, word_count, scroll_through? } OR none (idle)', () => {
    // Split into small assertions (each ≤6 \s*\n?\s* groups) to avoid the
    // long-chain parity-regex backtracking hazard now that the reading variant is
    // multi-line (W1223 added the optional scroll_through read-through flag).
    expect(body).toContain('export const BehavioralPauseParamsSchema = z.union([');
    // duration_ms variant (strict, single-line).
    expect(body).toMatch(
      /z\.object\(\{ duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\) \}\)\.strict\(\),/,
    );
    // reading variant — W1223 adds the optional scroll_through (read→scroll→read).
    expect(body).toMatch(
      /z\s*\n?\s*\.object\(\{\s*\n?\s*kind: z\.literal\('reading'\),\s*\n?\s*word_count: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*scroll_through: z\.boolean\(\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\),/,
    );
    // idle variant + union close.
    expect(body).toMatch(/NoParamsSchema,\s*\n?\s*\]\);/);
  });

  it('wait_for params pinned: predicate required + timeout_seconds int>0 optional', () => {
    expect(body).toMatch(/predicate: z\.string\(\)\.min\(1\),/);
    expect(body).toMatch(/timeout_seconds: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/);
  });

  it('execute_script params pinned: script required + args unknown[] optional', () => {
    expect(body).toMatch(/script: z\.string\(\)\.min\(1\),/);
    expect(body).toMatch(/args: z\.array\(z\.unknown\(\)\)\.optional\(\),/);
  });

  it('intentName→schema map pinned (all 12 routed, incl. press_key)', () => {
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
    // SessionStatus shape — toContain fragments (not a closed multi-line regex)
    // so the A3 W2682 inline doc comment between `detail` and `reason` doesn't
    // break the pin (the long-chain regex backtracking hazard / feedback).
    expect(body).toContain('export const SessionStatusSchema = z.object({');
    expect(body).toContain("type: z.literal('sessionStatus'),");
    expect(body).toContain('sessionId: z.string().min(1),');
    expect(body).toContain('status: z.string().min(1),');
    expect(body).toContain('timestamp: z.string(),');
    // Bounded like every sibling result field — a JWT-authed node must not inject
    // an unbounded string that persists into the customer-facing close reason.
    expect(body).toContain('detail: z.string().max(4096).optional(),');
    // A3 W2682 — the optional snake_case close reason on a terminal frame.
    expect(body).toContain('reason: z.string().min(1).max(512).optional(),');
    // A3 W2682 terminal-status vocabulary — the EXACT close-on set (drift-guarded).
    expect(body).toMatch(
      /export const TERMINAL_SESSION_STATUSES = new Set<string>\(\['ended', 'errored'\]\);/,
    );
    expect(body).toMatch(
      /export const HarnessOutboundSchema = z\.discriminatedUnion\('type', \[\s*\n?\s*IntentResultEnvelopeSchema,\s*\n?\s*SessionStatusSchema,\s*\n?\s*HeartbeatSchema,\s*\n?\s*CapabilityReportSchema,\s*\n?\s*ErrorEventSchema,\s*\n?\s*ProfileSavedSchema,\s*\n?\s*ChallengeDetectedSchema,\s*\n?\s*PageStateFrameSchema,\s*\n?\s*ProfileSaveFailedSchema,\s*\n?\s*CookiesResultSchema,\s*\n?\s*SetCookiesResultSchema,\s*\n?\s*NavigateHistoryResultSchema,\s*\n?\s*UploadResultSchema,\s*\n?\s*DownloadsListResultSchema,\s*\n?\s*DownloadDataResultSchema,\s*\n?\s*TrimProfileResultSchema,\s*\n?\s*\]\);/,
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
    expect(body).toMatch(
      /export const SetCookiesResultSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('setCookiesResult'\),\s*\n?\s*requestId: z\.string\(\)\.min\(1\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*ok: z\.boolean\(\)\.optional\(\),\s*\n?\s*error: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
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
    expect(body).toMatch(
      /export const NavigateHistoryResultSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('navigateHistoryResult'\),\s*\n?\s*requestId: z\.string\(\)\.min\(1\),\s*\n?\s*sessionId: z\.string\(\)\.min\(1\),\s*\n?\s*ok: z\.boolean\(\)\.optional\(\),\s*\n?\s*error: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('profile-trim frames pinned: trimProfile (CP→node, strict, JIT crypto envelope) + trimResult (node→CP, in union)', () => {
    // CP→node REQUEST — strict, carries the JIT crypto envelope (dek + presigned
    // GET/PUT) keyed by profile_id (OUT-OF-SESSION, no sessionId); the payload fields
    // are snake_case (profile_id / sealed_blob / sealed_blob_url / sealed_blob_put_url)
    // mirroring SessionAssign.ProfileInfo — only type + requestId stay camelCase (the
    // CP→node envelope convention). sealed_blob_put_url REQUIRED, one of
    // sealed_blob/sealed_blob_url supplies the input.
    expect(body).toMatch(
      /export const TrimProfileRequestSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\.literal\('trimProfile'\),\s*\n?\s*requestId: z\.string\(\)\.min\(1\),\s*\n?\s*profile_id: z\.string\(\)\.min\(1\),\s*\n?\s*dek: z\.string\(\)\.min\(1\),\s*\n?\s*sealed_blob: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*sealed_blob_url: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*sealed_blob_put_url: z\.string\(\)\.min\(1\),\s*\n?\s*\}\)\s*\n?\s*\.strict\(\);/,
    );
    // node→CP RESULT — ok?/newSizeBytes?/bytesReclaimed?/error?, lenient like cookiesResult.
    expect(body).toMatch(
      /export const TrimProfileResultSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('trimResult'\),\s*\n?\s*requestId: z\.string\(\)\.min\(1\),\s*\n?\s*profileId: z\.string\(\)\.min\(1\),\s*\n?\s*ok: z\.boolean\(\)\.optional\(\),\s*\n?\s*newSizeBytes: z\.number\(\)\.int\(\)\.nonnegative\(\)\.optional\(\),\s*\n?\s*bytesReclaimed: z\.number\(\)\.int\(\)\.nonnegative\(\)\.optional\(\),\s*\n?\s*error: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
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
    expect(body).toContain('sessionId: z.string().min(1),');
    expect(body).toContain('challengeId: z.string().min(1),');
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
    expect(body).toMatch(
      /export const ProfileSavedSchema = z\.object\(\{\s*\n?\s*type: z\.literal\('profileSaved'\),\s*\n?\s*sessionId: z\.string\(\),\s*\n?\s*profile_id: z\.string\(\),\s*\n?\s*sealed_blob: z\.string\(\)\.optional\(\),\s*\n?\s*stored: z\.boolean\(\)\.optional\(\),/,
    );
    // doc-150 item 5 — optional/forward-compat size_bytes (int, >= 0).
    expect(body).toContain('size_bytes: z.number().int().nonnegative().optional(),');
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
  });

  it('pageState (A3 W2730 wire spec) pinned to the outbound union + the RELAXED shape (Swift encodeIfPresent OMITS nil keys): url/title/error all optional, kind lenient, http_status optional+null-only. The previous REQUIRED url/error/http_status dropped EVERY real frame at safeParse → empty store → no live URL', () => {
    // Shape pinned via toContain fragments (NOT a closed multi-line regex — the
    // schema now carries comments + prettier may reflow it). Key relaxations:
    expect(body).toContain('export const PageStateFrameSchema = z.object({');
    expect(body).toContain("type: z.literal('pageState'),");
    expect(body).toContain("state: z.enum(['loading', 'loaded', 'errored', 'stalled']),");
    expect(body).toContain('url: z.string().nullable().optional(),');
    expect(body).toContain('title: z.string().nullable().optional(),');
    // Forward-compat per-tab attribution (A3 contract pending) — optional so a
    // frame without it still validates + is carried as null downstream.
    expect(body).toContain('tabId: z.string().optional(),');
    expect(body).toContain('kind: z.string().min(1),');
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
  });

  it('all 6 HarnessOutbound payloads pinned to A3 W124 field-sets (heartbeat/errorEvent/capabilityReport typed, not passthrough)', () => {
    // heartbeat — the A3 W124 base field-set (toContain fragments, not a
    // closed multi-line regex, so prettier reflow + the optional fleet
    // additions below don't break the pin).
    expect(body).toContain('export const HeartbeatSchema = z.object({');
    expect(body).toContain("type: z.literal('heartbeat'),");
    expect(body).toContain('macNodeId: z.string(),');
    expect(body).toContain('cpuPercent: z.number(),');
    expect(body).toContain('memoryPercent: z.number(),');
    expect(body).toContain('activeSessionCount: z.number().int().nonnegative(),');
    // …extended with the fleet-admin-panel telemetry (file-48 §A5; A3
    // W2189/W2197/W2199*), all OPTIONAL so an older node's beat still decodes;
    // field names mirror the Swift Codable Heartbeat 1:1 (else stripped).
    expect(body).toContain('maxConcurrent: z.number().int().nonnegative().optional(),');
    expect(body).toContain('uptimeSeconds: z.number().nonnegative().optional(),');
    expect(body).toContain('drainState: z.string().optional(),');
    expect(body).toContain(
      'sessionOutcomeCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),',
    );
    // Per-session liveness re-base (A2 W2679 / A3 driftstack f52699c37) — the
    // {agentSessionId → state} map the SessionLivenessStore reads. OPTIONAL +
    // omit-when-nil so an older node's beat still decodes byte-identically.
    expect(body).toContain(
      ".record(z.string(), z.enum(['active', 'provisioning', 'idle', 'terminating']))",
    );
    expect(body).toContain('thermalState: z.string().optional(),');
    expect(body).toContain('memoryPressureLevel: z.string().optional(),');
    expect(body).toContain('busiestCorePercent: z.number().optional(),');
    expect(body).toContain('diskFreePercent: z.number().optional(),');
    expect(body).toContain('harnessVersion: z.string().optional(),');
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
    expect(HARNESS_INTENT_NAMES).toHaveLength(12); // +press_key (A3 W1221)
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

  it('SessionStatus reason/detail are bounded — an oversized value from a JWT-authed node (persisted verbatim into the customer-facing closed_reason) is rejected', () => {
    const base = { type: 'sessionStatus', sessionId: 'agt_a', status: 'ended', timestamp: 't' };
    // reason bounded at 512 (matches ControlCommandSchema.reason).
    expect(HarnessOutboundSchema.safeParse({ ...base, reason: 'x'.repeat(512) }).success).toBe(
      true,
    );
    expect(HarnessOutboundSchema.safeParse({ ...base, reason: 'x'.repeat(513) }).success).toBe(
      false,
    );
    // detail bounded at 4096 (matches every sibling detail in this file).
    expect(HarnessOutboundSchema.safeParse({ ...base, detail: 'x'.repeat(4096) }).success).toBe(
      true,
    );
    expect(HarnessOutboundSchema.safeParse({ ...base, detail: 'x'.repeat(4097) }).success).toBe(
      false,
    );
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
});
