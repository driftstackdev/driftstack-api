// W435.A — drift guard for packages/api-types/src/sessions.ts.
// Customer-facing Session resource: status enum + archetype slug shape
// + V-169 SessionPurpose harness branch + InteractAction (intent-only
// per L-001) + WaitCondition + Capture + SessionEvent. Drift here
// either widens InteractAction past intent (coordinate primitives bleed
// from gui_control into the public SDK — L-001 violation) or breaks
// the SessionPurpose default (every paying customer session falls into
// a non-ATFP harness branch silently).
//
//   • SessionStatus enum: 5 values (creating | ready | busy | destroyed | errored).
//   • ArchetypeSchema: lowercase alphanumeric + underscore regex, 3..60.
//   • V-169 SessionPurpose enum: production_customer (default) |
//     cumulative_rig_validation | test_domain_probe + harness branching
//     rationale (AFP Layer 1 / ATFP firing semantics).
//   • DEFAULT_SESSION_PURPOSE = 'production_customer'.
//   • SessionSchema: 13-field shape (egress_capabilities added in
//     migration 0045 + cross-agent contract 7d5992d9); purpose
//     required (server defaults).
//   • L-001 — InteractAction intent-only; coordinate primitives stay
//     on gui_control plane, not customer-facing schema.
//   • InteractAction 4-branch discriminated union: tap/type/scroll/press.
//   • WaitCondition 4-branch discriminated union: selector /
//     selector_hidden / url_matches / time.
//   • CaptureKind enum: screenshot | dom_snapshot | pdf.
//   • SessionEventType enum: 8 values in exact order.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W435.A packages/api-types/src/sessions.ts content parity', () => {
  const body = read(LIB);

  it("imports shared ids plus the registry-derived selectable archetype schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{\s*ApiKeyIdSchema,\s*AccountIdSchema,\s*Iso8601Schema,\s*SelectableArchetypeIdSchema,\s*SessionEventIdSchema,\s*SessionIdSchema,\s*\} from '\.\/common\.js';/,
    );
  });

  it('SessionStatus enum: 5 values (creating | ready | busy | destroyed | errored) in exact order', () => {
    expect(body).toMatch(
      /export const SessionStatusSchema = z\.enum\(\['creating', 'ready', 'busy', 'destroyed', 'errored'\]\);/,
    );
    expect(body).toMatch(/export type SessionStatus = z\.infer<typeof SessionStatusSchema>;/);
  });

  it("ArchetypeSchema: lowercase alphanumeric + underscore regex '^[a-z0-9_]+$' min 3 max 60", () => {
    expect(body).toMatch(
      /export const ArchetypeSchema = z\s*\.string\(\)\s*\.regex\(\/\^\[a-z0-9_\]\+\$\/, \{ message: 'archetype slug is lowercase alphanumeric \+ underscores' \}\)\s*\.min\(3\)\s*\.max\(60\);/,
    );
  });

  it('SessionMetadataSchema enforces the advertised serialized UTF-8 byte cap with browser-safe TextEncoder', () => {
    expect(body).toMatch(/export const SESSION_METADATA_MAX_BYTES = 8192;/);
    expect(body).toMatch(/const sessionMetadataUtf8Encoder = new TextEncoder\(\);/);
    expect(body).toMatch(
      /sessionMetadataUtf8Encoder\.encode\(JSON\.stringify\(v\)\)\.byteLength <=\s*SESSION_METADATA_MAX_BYTES/,
    );
  });

  it('V-169 SessionPurpose framing pinned: harness config driver lives in WebKit driver; production_customer ephemeral+ATFP; cumulative_rig_validation persistent matches V-179 baseline; test_domain_probe tracker-context adversarial; MockDriver accepts but no-ops', () => {
    expect(body).toMatch(
      /\*\s*V-169 — session purpose drives harness configuration in the WebKit\s*\*\s*driver \(per AFP Layer 1 design from Agent 1's Phase 3 work; see\s*\*\s*`docs\/architecture\/afp-harness-configuration\.md` once Agent 1 lands\s*\*\s*the cross-reference doc\)\./,
    );
    expect(body).toMatch(
      /\*\s*- `production_customer` \(default\): ephemeral context \+\s*\*\s*`_resourceLoadStatisticsEnabled=YES`\. ATFP fires per iOS per-site\s*\*\s*logic\. This is what every paying-customer session uses\./,
    );
    expect(body).toMatch(
      /\*\s*- `cumulative_rig_validation`: persistent context, NOT ephemeral\.\s*\*\s*ATFP doesn't fire \(matches the V-179 baseline rig\)\. Used by Agent 1\s*\*\s*to validate that the static-fingerprint surface remains\s*\*\s*bit-identical across releases\./,
    );
    expect(body).toMatch(
      /\*\s*- `test_domain_probe`: ephemeral context on tracker-context URLs\.\s*\*\s*ATFP fires deterministically\. Used by Agent 1 for adversarial\s*\*\s*validation against detection vendors\./,
    );
    expect(body).toMatch(
      /\*\s*The MockDriver accepts the field but doesn't act on it \(the WebKit\s*\*\s*driver is where the harness branching lives\)\. Production customer\s*\*\s*sessions use the default; the other two purposes are reserved for\s*\*\s*internal validation tools and not part of the customer-facing API\s*\*\s*contract today\./,
    );
  });

  it('SessionPurpose enum + DEFAULT_SESSION_PURPOSE constant pinned', () => {
    expect(body).toMatch(
      /export const SessionPurposeSchema = z\.enum\(\[\s*'production_customer',\s*'cumulative_rig_validation',\s*'test_domain_probe',\s*\]\);/,
    );
    expect(body).toMatch(/export type SessionPurpose = z\.infer<typeof SessionPurposeSchema>;/);
    expect(body).toMatch(
      /export const DEFAULT_SESSION_PURPOSE: SessionPurpose = 'production_customer';/,
    );
  });

  it('SessionSchema: 14-field shape (id + account_id + api_key_id + status + archetype + V-169 purpose + label nullable + metadata nullable + egress_capabilities (migration 0045) nullable + egress_capability_report (Arc 5 EGRESS eg.1 migration 0054) nullable + 4 timestamps incl. last_state_at/destroyed_at nullable)', () => {
    expect(body).toMatch(
      /export const SessionSchema = z\.object\(\{\s*id: SessionIdSchema,\s*account_id: AccountIdSchema,\s*api_key_id: ApiKeyIdSchema,\s*status: SessionStatusSchema,\s*archetype: ArchetypeSchema,\s*\/\*\* V-169 — harness purpose; defaults to `production_customer`\. \*\/\s*purpose: SessionPurposeSchema,\s*label: z\.string\(\)\.nullable\(\),\s*metadata: SessionMetadataSchema\.nullable\(\),\s*[\s\S]*?egress_capabilities: EgressCapabilitiesSchema\.nullable\(\),\s*[\s\S]*?egress_capability_report: z\.record\(z\.unknown\(\)\)\.nullable\(\),\s*created_at: Iso8601Schema,\s*updated_at: Iso8601Schema,\s*last_state_at: Iso8601Schema\.nullable\(\),\s*destroyed_at: Iso8601Schema\.nullable\(\),\s*\}\);/,
    );
  });

  it('CreateSessionRequest: selectable archetype optional + canonical bounded label + metadata/profile/persona fields', () => {
    expect(body).toMatch(/export const SessionLabelSchema = z\.string\(\)\.max\(120\);/);
    expect(body).toMatch(
      /export const CreateSessionRequestSchema = z\.object\(\{\s*archetype: SelectableArchetypeIdSchema\.optional\(\),\s*\/\*\* V-169 — harness purpose; defaults to `production_customer`\. \*\/\s*purpose: SessionPurposeSchema\.optional\(\),\s*label: SessionLabelSchema\.optional\(\),\s*metadata: SessionMetadataSchema\.optional\(\),\s*[\s\S]*?profile_id: ProfileIdInputSchema\.optional\(\),\s*[\s\S]*?behavioral_profile: BehavioralProfileSchema\.optional\(\),\s*\}\);/,
    );
    // 2026-05-20 anti-enumeration framing pinned
    expect(body).toMatch(/a profile_id outside it returns/);
    expect(body).toMatch(/Server validates that the profile/);
    // V-1101 — the scope is the EFFECTIVE account, not the calling one.
    // routes/sessions.ts resolves ownerAccountId from the team header and
    // scopes the lookup to that, so a team admin acting as an owner passes
    // the OWNER's profiles and would 404 on their own.
    expect(body, 'the profile-binding scope is no longer stated').toMatch(
      /belongs\s*\*\s*to the EFFECTIVE account/,
    );
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /profile\s*\*\s*belongs to the calling account/,
    );
  });

  it('LaunchProfileRequest is a strict label-only projection of the canonical create schema', () => {
    expect(body).toMatch(
      /export const LaunchProfileRequestSchema = CreateSessionRequestSchema\.pick\(\{ label: true \}\)\.strict\(\);/,
    );
    expect(body).toMatch(
      /export type LaunchProfileRequest = z\.infer<typeof LaunchProfileRequestSchema>;/,
    );
  });

  it('NavigateRequest: url http/https-only (W487 .refine) + timeout_ms 1000..120000 optional + wait_until enum (load|domcontentloaded|networkidle) default load; NavigateResponse: url + status 100..599 + final_url + duration_ms', () => {
    // W487 — url is http/https-only. V-1499 made that a `regex` so the scheme
    // allowlist reaches the published document; explicit character classes
    // because the `/i` flag has no JSON Schema expression and uppercase
    // schemes are accepted. The
    // schema spans multiple lines now, so assert the field shape + refine + the
    // timeout/wait_until fields piecewise rather than as one frozen block.
    expect(body).toMatch(
      /export const NavigateRequestSchema = z\.object\(\{[\s\S]*?url: z[\s\S]*?\.string\(\)[\s\S]*?\.url\(\)[\s\S]*?\.regex\(\/\^\[Hh\]\[Tt\]\[Tt\]\[Pp\]\[Ss\]\?:\\\/\\\/\/, \{/,
    );
    expect(body).toMatch(
      /timeout_ms: z\.number\(\)\.int\(\)\.min\(1000\)\.max\(120_000\)\.optional\(\),\s*\/\/ Wait policy after navigation completes\.\s*wait_until: z\.enum\(\['load', 'domcontentloaded', 'networkidle'\]\)\.default\('load'\),/,
    );
    expect(body).toMatch(
      /export const NavigateResponseSchema = z\.object\(\{\s*url: z\.string\(\)\.url\(\),\s*status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\),\s*\/\/ Final URL \(may differ from request after redirects\)\.\s*final_url: z\.string\(\)\.url\(\),\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\}\);/,
    );
  });

  it('L-001 framing pinned: InteractAction intent-only; coordinate primitives (tap_at, tap.offset, etc.) live on gui_control plane', () => {
    expect(body).toMatch(
      /\/\/ Customer-facing InteractAction is intent-only per L-001 — coordinate\s*\/\/ primitives \(tap_at, tap\.offset, etc\.\) live on the gui_control plane,\s*\/\/ not here\. See docs\/locked-decisions\.md\./,
    );
  });

  it('InteractAction discriminatedUnion("kind"): tap + type (text max 10000 + delay_ms 0..500 optional) + scroll (selector optional + delta_x/y default 0) + press (key 1..20)', () => {
    expect(body).toMatch(
      /export const InteractActionSchema = z\.discriminatedUnion\('kind', \[\s*z\.object\(\{\s*kind: z\.literal\('tap'\),\s*selector: z\.string\(\)\.min\(1\),\s*\}\),\s*z\.object\(\{\s*kind: z\.literal\('type'\),\s*selector: z\.string\(\)\.min\(1\),\s*text: z\.string\(\)\.max\(10_000\),\s*\/\/ Requested inter-key delay in ms; the public contract accepts only 0\.\.500\.\s*delay_ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(500\)\.optional\(\),[\s\S]{0,600}?sensitive: z\.boolean\(\)\.optional\(\),\s*\}\),\s*z\.object\(\{\s*kind: z\.literal\('scroll'\),\s*selector: z\.string\(\)\.min\(1\)\.optional\(\),\s*delta_x: z\.number\(\)\.int\(\)\.default\(0\),\s*delta_y: z\.number\(\)\.int\(\)\.default\(0\),\s*\}\),\s*z\.object\(\{\s*kind: z\.literal\('press'\),\s*key: z\.string\(\)\.min\(1\)\.max\(20\),\s*\}\),\s*\]\);/,
    );
    expect(body).not.toContain('mock driver respects bounds, real driver clamps');
  });

  it('InteractRequest: action + timeout_ms 100..60000 optional; InteractResponse: ok literal(true) + duration_ms', () => {
    expect(body).toMatch(
      /export const InteractRequestSchema = z\.object\(\{\s*action: InteractActionSchema,\s*timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60_000\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const InteractResponseSchema = z\.object\(\{\s*ok: z\.literal\(true\),\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\}\);/,
    );
  });

  it('WaitCondition discriminatedUnion("kind"): selector + selector_hidden + url_matches (pattern) + time (ms 0..60000)', () => {
    expect(body).toMatch(
      /export const WaitConditionSchema = z\.discriminatedUnion\('kind', \[\s*z\.object\(\{ kind: z\.literal\('selector'\), selector: z\.string\(\)\.min\(1\) \}\),\s*z\.object\(\{ kind: z\.literal\('selector_hidden'\), selector: z\.string\(\)\.min\(1\) \}\),\s*z\.object\(\{ kind: z\.literal\('url_matches'\), pattern: z\.string\(\)\.min\(1\) \}\),\s*z\.object\(\{ kind: z\.literal\('time'\), ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(60_000\) \}\),\s*\]\);/,
    );
  });

  it('WaitRequest: condition + timeout_ms 100..120000 optional; WaitResponse: satisfied bool + duration_ms', () => {
    expect(body).toMatch(
      /export const WaitRequestSchema = z\.object\(\{\s*condition: WaitConditionSchema,\s*timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(120_000\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const WaitResponseSchema = z\.object\(\{\s*satisfied: z\.boolean\(\),\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\}\);/,
    );
  });

  it('SessionState: url nullable + title nullable + cookies array of records (driver-controlled) + local_storage record + captured_at', () => {
    expect(body).toMatch(
      /export const SessionStateSchema = z\.object\(\{\s*url: z\.string\(\)\.url\(\)\.nullable\(\),\s*title: z\.string\(\)\.nullable\(\),\s*\/\/ Serialised cookies \(driver-controlled shape\)\.\s*cookies: z\.array\(z\.record\(z\.unknown\(\)\)\),\s*\/\/ Local storage snapshot\.\s*local_storage: z\.record\(z\.string\(\)\),[\s\S]{0,400}?page_state: PageStateSchema\.nullable\(\)\.default\(null\),\s*captured_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it("CaptureKind enum: 'screenshot' | 'dom_snapshot' | 'pdf'; CaptureRequest: kind + full_page default false; CaptureResponse: kind + data + encoding base64|utf8 + byte_size + duration_ms", () => {
    expect(body).toMatch(
      /export const CaptureKindSchema = z\.enum\(\['screenshot', 'dom_snapshot', 'pdf'\]\);/,
    );
    expect(body).toMatch(/export type CaptureKind = z\.infer<typeof CaptureKindSchema>;/);
    expect(body).toMatch(
      /export const CaptureRequestSchema = z\.object\(\{\s*kind: CaptureKindSchema,\s*\/\/ For screenshots: full-page or viewport\.\s*full_page: z\.boolean\(\)\.default\(false\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CaptureResponseSchema = z\.object\(\{\s*kind: CaptureKindSchema,\s*\/\/ base64 for binary captures, raw text for DOM snapshots\.\s*data: z\.string\(\),\s*encoding: z\.enum\(\['base64', 'utf8'\]\),\s*byte_size: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\}\);/,
    );
  });

  it('SessionEventType enum: 8 values (created/navigated/interacted/waited/state_captured/screenshot_captured/destroyed/errored) in exact order', () => {
    expect(body).toMatch(
      /export const SessionEventTypeSchema = z\.enum\(\[\s*'created',\s*'navigated',\s*'interacted',\s*'waited',\s*'state_captured',\s*'screenshot_captured',\s*'destroyed',\s*'errored',\s*\]\);/,
    );
  });

  it('SessionEvent shape: id + session_id + type + payload nullable + duration_ms nullable + created_at', () => {
    expect(body).toMatch(
      /export const SessionEventSchema = z\.object\(\{\s*id: SessionEventIdSchema,\s*session_id: SessionIdSchema,\s*type: SessionEventTypeSchema,\s*payload: z\.record\(z\.unknown\(\)\)\.nullable\(\),\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\)\.nullable\(\),\s*created_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it('Extract contract pinned (harness intent A3 W456): ExtractionType text|attribute|list + ExtractionSpec {name,selector,type,attribute?,transform:number?,extract?} + ExtractRequest {extractions: 1..100} + ExtractResponse {value: record}. Drift here breaks the cross-package contract the /v1/sessions/:id/extract route + all 3 SDK extract methods import', () => {
    expect(body).toMatch(
      /export const ExtractionTypeSchema = z\.enum\(\['text', 'attribute', 'list'\]\);/,
    );
    // List sub-extraction is one level only (sub-type is text|attribute, no nested list).
    expect(body).toMatch(
      /export const ListFieldExtractionSchema = z\.object\(\{\s*type: z\.enum\(\['text', 'attribute'\]\),/,
    );
    expect(body).toMatch(/export const ExtractionSpecSchema = z\.object\(\{/);
    expect(body).toMatch(/name: z\.string\(\)\.min\(1\),/);
    expect(body).toMatch(/type: ExtractionTypeSchema,/);
    expect(body).toMatch(/transform: z\.literal\('number'\)\.optional\(\),/);
    expect(body).toMatch(
      /extract: z\.record\(z\.string\(\), ListFieldExtractionSchema\)\.optional\(\),/,
    );
    // Harness ≤100 bound + ≥1.
    expect(body).toMatch(
      /export const ExtractRequestSchema = z\.object\(\{[\s\S]*?extractions: z\.array\(ExtractionSpecSchema\)\.min\(1\)\.max\(100\),/,
    );
    expect(body).toMatch(
      /export const ExtractResponseSchema = z\.object\(\{[\s\S]*?value: z\.record\(z\.string\(\), z\.unknown\(\)\),/,
    );
  });

  it('Search contract pins query 1..10000 and the strict completed-vs-zero-submit-truncated response with 0..600000ms duration', () => {
    expect(body).toMatch(
      /export const SearchRequestSchema = z\.object\(\{[\s\S]*?query: z\.string\(\)\.min\(1\)\.max\(10_000\),[\s\S]*?search_selector: z\.string\(\)\.min\(1\)\.max\(262_144\)\.optional\(\),[\s\S]*?submit: z\.boolean\(\)\.default\(true\),[\s\S]*?wait_for_results_selector: z\.string\(\)\.min\(1\)\.max\(262_144\)\.optional\(\),[\s\S]*?timeout_seconds: z\.number\(\)\.int\(\)\.min\(1\)\.max\(120\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const SearchDurationMsSchema = z\.number\(\)\.int\(\)\.min\(0\)\.max\(600_000\);/,
    );
    expect(body).toMatch(
      /const SearchCompletedResponseSchema = z[\s\S]*?submitted: z\s*\.boolean\(\)\s*\.describe\([\s\S]*?query_truncated: z\.literal\(false\),[\s\S]*?results_visible: z\s*\.boolean\(\)\s*\.optional\(\)\s*\.describe\([\s\S]*?duration_ms: SearchDurationMsSchema,[\s\S]*?\.strict\(\);/,
    );
    expect(body).toMatch(
      /const SearchTruncatedResponseSchema = z[\s\S]*?submitted: z\s*\.literal\(false\)\s*\.describe\([\s\S]*?query_truncated: z\.literal\(true\),[\s\S]*?duration_ms: SearchDurationMsSchema,[\s\S]*?\.strict\(\);/,
    );
    expect(body).toMatch(
      /export const SearchResponseSchema = z\.discriminatedUnion\('query_truncated', \[[\s\S]*?SearchCompletedResponseSchema,[\s\S]*?SearchTruncatedResponseSchema,[\s\S]*?\]\);/,
    );
  });

  it('SessionLogin contract pins the request and strict submitted-vs-truncated response union, including the activation-held 0..600000ms duration', () => {
    expect(body).toMatch(
      /export const SessionLoginRequestSchema = z\.object\(\{[\s\S]*?username: z\.string\(\)\.min\(1\)\.max\(10_000\),[\s\S]*?password: z\.string\(\)\.min\(1\)\.max\(10_000\),[\s\S]*?username_selector: z\.string\(\)\.min\(1\)\.max\(262_144\)\.optional\(\),[\s\S]*?password_selector: z\.string\(\)\.min\(1\)\.max\(262_144\)\.optional\(\),[\s\S]*?submit_selector: z\.string\(\)\.min\(1\)\.max\(262_144\)\.optional\(\),[\s\S]*?success_selector: z\.string\(\)\.min\(1\)\.max\(262_144\)\.optional\(\),[\s\S]*?timeout_seconds: z\.number\(\)\.int\(\)\.min\(1\)\.max\(120\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const SessionLoginDurationMsSchema = z\.number\(\)\.int\(\)\.min\(0\)\.max\(600_000\);/,
    );
    expect(body).toMatch(
      /const SessionLoginSubmittedResponseSchema = z[\s\S]*?submitted: z\.literal\(true\),[\s\S]*?credentials_truncated: z\.literal\(false\),[\s\S]*?logged_in: z\s*\.boolean\(\)\s*\.describe\([\s\S]*?post_login_url: z\.string\(\)\.optional\(\),[\s\S]*?duration_ms: SessionLoginDurationMsSchema,[\s\S]*?\.strict\(\);/,
    );
    // post_login_url is the plain session URL. This lane invents no URL
    // mutation, and an authorized `GET /state` already returns the same
    // value — so a "redacted" adjective here would be a false guarantee that
    // callers (and future log-handling code) could rely on.
    expect(body).toMatch(
      /\/\*\* The session URL after submit settled, when the browser supplied one\.\s*\n\s*\*\s*Not redacted or otherwise rewritten: an authorized `GET \/state` already\s*\n\s*\*\s*returns the same URL\. Keep it out of logs like any other session URL\. \*\/\s*\n\s*post_login_url: z\.string\(\)\.optional\(\),/,
    );
    expect(body).not.toMatch(/redacted URL/);
    expect(body).toMatch(
      /const SessionLoginTruncatedResponseSchema = z[\s\S]*?submitted: z\s*\.literal\(false\)\s*\.describe\([\s\S]*?credentials_truncated: z\.literal\(true\),[\s\S]*?logged_in: z\.literal\(false\),[\s\S]*?duration_ms: SessionLoginDurationMsSchema,[\s\S]*?\.strict\(\);/,
    );
    expect(body).toMatch(
      /export const SessionLoginResponseSchema = z\.discriminatedUnion\('credentials_truncated', \[[\s\S]*?SessionLoginSubmittedResponseSchema,[\s\S]*?SessionLoginTruncatedResponseSchema,[\s\S]*?\]\);/,
    );
  });

  it('CRITICAL the login schema comment must not name a recipe-execution surface. `execute_recipe` is not implemented anywhere; pointing at it from a shipped contract file is a fake-availability claim.', () => {
    expect(body).toMatch(
      /Recipes are capture-only today — there is no\s*\n\s*\/\/ recipe-execution surface/,
    );
    expect(body).not.toMatch(/execute_recipe/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
