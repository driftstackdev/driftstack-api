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
      /import \{\s*\n?\s*ApiKeyIdSchema,\s*\n?\s*AccountIdSchema,\s*\n?\s*Iso8601Schema,\s*\n?\s*SelectableArchetypeIdSchema,\s*\n?\s*SessionEventIdSchema,\s*\n?\s*SessionIdSchema,\s*\n?\s*\} from '\.\/common\.js';/,
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
      /export const ArchetypeSchema = z\s*\n?\s*\.string\(\)\s*\n?\s*\.regex\(\/\^\[a-z0-9_\]\+\$\/, \{ message: 'archetype slug is lowercase alphanumeric \+ underscores' \}\)\s*\n?\s*\.min\(3\)\s*\n?\s*\.max\(60\);/,
    );
  });

  it('SessionMetadataSchema enforces the advertised serialized UTF-8 byte cap with browser-safe TextEncoder', () => {
    expect(body).toMatch(/export const SESSION_METADATA_MAX_BYTES = 8192;/);
    expect(body).toMatch(/const sessionMetadataUtf8Encoder = new TextEncoder\(\);/);
    expect(body).toMatch(
      /sessionMetadataUtf8Encoder\.encode\(JSON\.stringify\(v\)\)\.byteLength <=\s*\n?\s*SESSION_METADATA_MAX_BYTES/,
    );
  });

  it('V-169 SessionPurpose framing pinned: harness config driver lives in WebKit driver; production_customer ephemeral+ATFP; cumulative_rig_validation persistent matches V-179 baseline; test_domain_probe tracker-context adversarial; MockDriver accepts but no-ops', () => {
    expect(body).toMatch(
      /\*\s*V-169 — session purpose drives harness configuration in the WebKit\s*\n?\s*\*\s*driver \(per AFP Layer 1 design from Agent 1's Phase 3 work; see\s*\n?\s*\*\s*`docs\/architecture\/afp-harness-configuration\.md` once Agent 1 lands\s*\n?\s*\*\s*the cross-reference doc\)\./,
    );
    expect(body).toMatch(
      /\*\s*- `production_customer` \(default\): ephemeral context \+\s*\n?\s*\*\s*`_resourceLoadStatisticsEnabled=YES`\. ATFP fires per iOS per-site\s*\n?\s*\*\s*logic\. This is what every paying-customer session uses\./,
    );
    expect(body).toMatch(
      /\*\s*- `cumulative_rig_validation`: persistent context, NOT ephemeral\.\s*\n?\s*\*\s*ATFP doesn't fire \(matches the V-179 baseline rig\)\. Used by Agent 1\s*\n?\s*\*\s*to validate that the static-fingerprint surface remains\s*\n?\s*\*\s*bit-identical across releases\./,
    );
    expect(body).toMatch(
      /\*\s*- `test_domain_probe`: ephemeral context on tracker-context URLs\.\s*\n?\s*\*\s*ATFP fires deterministically\. Used by Agent 1 for adversarial\s*\n?\s*\*\s*validation against detection vendors\./,
    );
    expect(body).toMatch(
      /\*\s*The MockDriver accepts the field but doesn't act on it \(the WebKit\s*\n?\s*\*\s*driver is where the harness branching lives\)\. Production customer\s*\n?\s*\*\s*sessions use the default; the other two purposes are reserved for\s*\n?\s*\*\s*internal validation tools and not part of the customer-facing API\s*\n?\s*\*\s*contract today\./,
    );
  });

  it('SessionPurpose enum + DEFAULT_SESSION_PURPOSE constant pinned', () => {
    expect(body).toMatch(
      /export const SessionPurposeSchema = z\.enum\(\[\s*\n?\s*'production_customer',\s*\n?\s*'cumulative_rig_validation',\s*\n?\s*'test_domain_probe',\s*\n?\s*\]\);/,
    );
    expect(body).toMatch(/export type SessionPurpose = z\.infer<typeof SessionPurposeSchema>;/);
    expect(body).toMatch(
      /export const DEFAULT_SESSION_PURPOSE: SessionPurpose = 'production_customer';/,
    );
  });

  it('SessionSchema: 14-field shape (id + account_id + api_key_id + status + archetype + V-169 purpose + label nullable + metadata nullable + egress_capabilities (migration 0045) nullable + egress_capability_report (Arc 5 EGRESS eg.1 migration 0054) nullable + 4 timestamps incl. last_state_at/destroyed_at nullable)', () => {
    expect(body).toMatch(
      /export const SessionSchema = z\.object\(\{\s*\n?\s*id: SessionIdSchema,\s*\n?\s*account_id: AccountIdSchema,\s*\n?\s*api_key_id: ApiKeyIdSchema,\s*\n?\s*status: SessionStatusSchema,\s*\n?\s*archetype: ArchetypeSchema,\s*\n?\s*\/\*\* V-169 — harness purpose; defaults to `production_customer`\. \*\/\s*\n?\s*purpose: SessionPurposeSchema,\s*\n?\s*label: z\.string\(\)\.nullable\(\),\s*\n?\s*metadata: SessionMetadataSchema\.nullable\(\),\s*\n?\s*[\s\S]*?egress_capabilities: EgressCapabilitiesSchema\.nullable\(\),\s*\n?\s*[\s\S]*?egress_capability_report: z\.record\(z\.unknown\(\)\)\.nullable\(\),\s*\n?\s*created_at: Iso8601Schema,\s*\n?\s*updated_at: Iso8601Schema,\s*\n?\s*last_state_at: Iso8601Schema\.nullable\(\),\s*\n?\s*destroyed_at: Iso8601Schema\.nullable\(\),\s*\n?\s*\}\);/,
    );
  });

  it('CreateSessionRequest: selectable archetype optional + purpose/label/metadata/profile/persona fields', () => {
    expect(body).toMatch(
      /export const CreateSessionRequestSchema = z\.object\(\{\s*\n?\s*archetype: SelectableArchetypeIdSchema\.optional\(\),\s*\n?\s*\/\*\* V-169 — harness purpose; defaults to `production_customer`\. \*\/\s*\n?\s*purpose: SessionPurposeSchema\.optional\(\),\s*\n?\s*label: z\.string\(\)\.max\(120\)\.optional\(\),\s*\n?\s*metadata: SessionMetadataSchema\.optional\(\),\s*\n?\s*[\s\S]*?profile_id: z\.string\(\)\.optional\(\),\s*\n?\s*[\s\S]*?behavioral_profile: BehavioralProfileSchema\.optional\(\),\s*\n?\s*\}\);/,
    );
    // 2026-05-20 anti-enumeration framing pinned
    expect(body).toMatch(/cross-account profile_id returns/);
    expect(body).toMatch(/Server validates that the profile/);
  });

  it('NavigateRequest: url http/https-only (W487 .refine) + timeout_ms 1000..120000 optional + wait_until enum (load|domcontentloaded|networkidle) default load; NavigateResponse: url + status 100..599 + final_url + duration_ms', () => {
    // W487 — url is z.string().url().refine(/^https?:/) (http/https only); the
    // schema spans multiple lines now, so assert the field shape + refine + the
    // timeout/wait_until fields piecewise rather than as one frozen block.
    expect(body).toMatch(
      /export const NavigateRequestSchema = z\.object\(\{[\s\S]*?url: z[\s\S]*?\.string\(\)[\s\S]*?\.url\(\)[\s\S]*?\.refine\(\(u\) => \/\^https\?:\\\/\\\/\/i\.test\(u\)/,
    );
    expect(body).toMatch(
      /timeout_ms: z\.number\(\)\.int\(\)\.min\(1000\)\.max\(120_000\)\.optional\(\),\s*\n?\s*\/\/ Wait policy after navigation completes\.\s*\n?\s*wait_until: z\.enum\(\['load', 'domcontentloaded', 'networkidle'\]\)\.default\('load'\),/,
    );
    expect(body).toMatch(
      /export const NavigateResponseSchema = z\.object\(\{\s*\n?\s*url: z\.string\(\)\.url\(\),\s*\n?\s*status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\),\s*\n?\s*\/\/ Final URL \(may differ from request after redirects\)\.\s*\n?\s*final_url: z\.string\(\)\.url\(\),\s*\n?\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
  });

  it('L-001 framing pinned: InteractAction intent-only; coordinate primitives (tap_at, tap.offset, etc.) live on gui_control plane', () => {
    expect(body).toMatch(
      /\/\/ Customer-facing InteractAction is intent-only per L-001 — coordinate\s*\n?\s*\/\/ primitives \(tap_at, tap\.offset, etc\.\) live on the gui_control plane,\s*\n?\s*\/\/ not here\. See docs\/locked-decisions\.md\./,
    );
  });

  it('InteractAction discriminatedUnion("kind"): tap + type (text max 10000 + delay_ms 0..500 optional) + scroll (selector optional + delta_x/y default 0) + press (key 1..20)', () => {
    expect(body).toMatch(
      /export const InteractActionSchema = z\.discriminatedUnion\('kind', \[\s*\n?\s*z\.object\(\{\s*\n?\s*kind: z\.literal\('tap'\),\s*\n?\s*selector: z\.string\(\)\.min\(1\),\s*\n?\s*\}\),\s*\n?\s*z\.object\(\{\s*\n?\s*kind: z\.literal\('type'\),\s*\n?\s*selector: z\.string\(\)\.min\(1\),\s*\n?\s*text: z\.string\(\)\.max\(10_000\),\s*\n?\s*\/\/ Requested inter-key delay in ms; the public contract accepts only 0\.\.500\.\s*\n?\s*delay_ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(500\)\.optional\(\),[\s\S]{0,600}?sensitive: z\.boolean\(\)\.optional\(\),\s*\n?\s*\}\),\s*\n?\s*z\.object\(\{\s*\n?\s*kind: z\.literal\('scroll'\),\s*\n?\s*selector: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*delta_x: z\.number\(\)\.int\(\)\.default\(0\),\s*\n?\s*delta_y: z\.number\(\)\.int\(\)\.default\(0\),\s*\n?\s*\}\),\s*\n?\s*z\.object\(\{\s*\n?\s*kind: z\.literal\('press'\),\s*\n?\s*key: z\.string\(\)\.min\(1\)\.max\(20\),\s*\n?\s*\}\),\s*\n?\s*\]\);/,
    );
    expect(body).not.toContain('mock driver respects bounds, real driver clamps');
  });

  it('InteractRequest: action + timeout_ms 100..60000 optional; InteractResponse: ok literal(true) + duration_ms', () => {
    expect(body).toMatch(
      /export const InteractRequestSchema = z\.object\(\{\s*\n?\s*action: InteractActionSchema,\s*\n?\s*timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60_000\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const InteractResponseSchema = z\.object\(\{\s*\n?\s*ok: z\.literal\(true\),\s*\n?\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
  });

  it('WaitCondition discriminatedUnion("kind"): selector + selector_hidden + url_matches (pattern) + time (ms 0..60000)', () => {
    expect(body).toMatch(
      /export const WaitConditionSchema = z\.discriminatedUnion\('kind', \[\s*\n?\s*z\.object\(\{ kind: z\.literal\('selector'\), selector: z\.string\(\)\.min\(1\) \}\),\s*\n?\s*z\.object\(\{ kind: z\.literal\('selector_hidden'\), selector: z\.string\(\)\.min\(1\) \}\),\s*\n?\s*z\.object\(\{ kind: z\.literal\('url_matches'\), pattern: z\.string\(\)\.min\(1\) \}\),\s*\n?\s*z\.object\(\{ kind: z\.literal\('time'\), ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(60_000\) \}\),\s*\n?\s*\]\);/,
    );
  });

  it('WaitRequest: condition + timeout_ms 100..120000 optional; WaitResponse: satisfied bool + duration_ms', () => {
    expect(body).toMatch(
      /export const WaitRequestSchema = z\.object\(\{\s*\n?\s*condition: WaitConditionSchema,\s*\n?\s*timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(120_000\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const WaitResponseSchema = z\.object\(\{\s*\n?\s*satisfied: z\.boolean\(\),\s*\n?\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
  });

  it('SessionState: url nullable + title nullable + cookies array of records (driver-controlled) + local_storage record + captured_at', () => {
    expect(body).toMatch(
      /export const SessionStateSchema = z\.object\(\{\s*\n?\s*url: z\.string\(\)\.url\(\)\.nullable\(\),\s*\n?\s*title: z\.string\(\)\.nullable\(\),\s*\n?\s*\/\/ Serialised cookies \(driver-controlled shape\)\.\s*\n?\s*cookies: z\.array\(z\.record\(z\.unknown\(\)\)\),\s*\n?\s*\/\/ Local storage snapshot\.\s*\n?\s*local_storage: z\.record\(z\.string\(\)\),[\s\S]{0,400}?page_state: PageStateSchema\.nullable\(\)\.default\(null\),\s*\n?\s*captured_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it("CaptureKind enum: 'screenshot' | 'dom_snapshot' | 'pdf'; CaptureRequest: kind + full_page default false; CaptureResponse: kind + data + encoding base64|utf8 + byte_size + duration_ms", () => {
    expect(body).toMatch(
      /export const CaptureKindSchema = z\.enum\(\['screenshot', 'dom_snapshot', 'pdf'\]\);/,
    );
    expect(body).toMatch(/export type CaptureKind = z\.infer<typeof CaptureKindSchema>;/);
    expect(body).toMatch(
      /export const CaptureRequestSchema = z\.object\(\{\s*\n?\s*kind: CaptureKindSchema,\s*\n?\s*\/\/ For screenshots: full-page or viewport\.\s*\n?\s*full_page: z\.boolean\(\)\.default\(false\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CaptureResponseSchema = z\.object\(\{\s*\n?\s*kind: CaptureKindSchema,\s*\n?\s*\/\/ base64 for binary captures, raw text for DOM snapshots\.\s*\n?\s*data: z\.string\(\),\s*\n?\s*encoding: z\.enum\(\['base64', 'utf8'\]\),\s*\n?\s*byte_size: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
  });

  it('SessionEventType enum: 8 values (created/navigated/interacted/waited/state_captured/screenshot_captured/destroyed/errored) in exact order', () => {
    expect(body).toMatch(
      /export const SessionEventTypeSchema = z\.enum\(\[\s*\n?\s*'created',\s*\n?\s*'navigated',\s*\n?\s*'interacted',\s*\n?\s*'waited',\s*\n?\s*'state_captured',\s*\n?\s*'screenshot_captured',\s*\n?\s*'destroyed',\s*\n?\s*'errored',\s*\n?\s*\]\);/,
    );
  });

  it('SessionEvent shape: id + session_id + type + payload nullable + duration_ms nullable + created_at', () => {
    expect(body).toMatch(
      /export const SessionEventSchema = z\.object\(\{\s*\n?\s*id: SessionEventIdSchema,\s*\n?\s*session_id: SessionIdSchema,\s*\n?\s*type: SessionEventTypeSchema,\s*\n?\s*payload: z\.record\(z\.unknown\(\)\)\.nullable\(\),\s*\n?\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\)\.nullable\(\),\s*\n?\s*created_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('Extract contract pinned (harness intent A3 W456): ExtractionType text|attribute|list + ExtractionSpec {name,selector,type,attribute?,transform:number?,extract?} + ExtractRequest {extractions: 1..100} + ExtractResponse {value: record}. Drift here breaks the cross-package contract the /v1/sessions/:id/extract route + all 3 SDK extract methods import', () => {
    expect(body).toMatch(
      /export const ExtractionTypeSchema = z\.enum\(\['text', 'attribute', 'list'\]\);/,
    );
    // List sub-extraction is one level only (sub-type is text|attribute, no nested list).
    expect(body).toMatch(
      /export const ListFieldExtractionSchema = z\.object\(\{\s*\n?\s*type: z\.enum\(\['text', 'attribute'\]\),/,
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

  it('Search contract pinned (harness intent A3 W244/W245): SearchRequest {query min1, search_selector?, submit default true, wait_for_results_selector?, timeout_seconds 1..120?} + SearchResponse {submitted, results_visible?}. Drift breaks the cross-package contract the /v1/sessions/:id/search route + 3 SDK search methods import', () => {
    expect(body).toMatch(
      /export const SearchRequestSchema = z\.object\(\{[\s\S]*?query: z\.string\(\)\.min\(1\),[\s\S]*?search_selector: z\.string\(\)\.optional\(\),[\s\S]*?submit: z\.boolean\(\)\.default\(true\),[\s\S]*?wait_for_results_selector: z\.string\(\)\.optional\(\),[\s\S]*?timeout_seconds: z\.number\(\)\.int\(\)\.min\(1\)\.max\(120\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const SearchResponseSchema = z\.object\(\{[\s\S]*?submitted: z\.boolean\(\),[\s\S]*?results_visible: z\.boolean\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('SessionLogin contract pinned (harness intent A3 W244/W245): SessionLoginRequest {username min1, password min1 SENSITIVE, username_selector?, password_selector?, submit_selector?, success_selector?, timeout_seconds 1..120?} + SessionLoginResponse {logged_in, post_login_url?}. Named SessionLogin* to avoid colliding with auth LoginRequest. Drift breaks the cross-package contract the /v1/sessions/:id/login route + 3 SDK login methods import', () => {
    expect(body).toMatch(
      /export const SessionLoginRequestSchema = z\.object\(\{[\s\S]*?username: z\.string\(\)\.min\(1\),[\s\S]*?password: z\.string\(\)\.min\(1\),[\s\S]*?username_selector: z\.string\(\)\.optional\(\),[\s\S]*?password_selector: z\.string\(\)\.optional\(\),[\s\S]*?submit_selector: z\.string\(\)\.optional\(\),[\s\S]*?success_selector: z\.string\(\)\.optional\(\),[\s\S]*?timeout_seconds: z\.number\(\)\.int\(\)\.min\(1\)\.max\(120\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const SessionLoginResponseSchema = z\.object\(\{[\s\S]*?logged_in: z\.boolean\(\),[\s\S]*?post_login_url: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
