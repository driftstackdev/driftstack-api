// W439.C — drift guard for apps/server/src/lib/openapi.ts.
// OpenAPI 3.1 spec generator. Drift here either re-orders the
// extendZodWithOpenApi setup (registry.register stops attaching
// .openapi() metadata silently) or registers an inline anonymous
// shape on a route (codegen produces nameless types — breaks
// Pydantic / Go struct consumers).
//
//   • Header framing pinned: zod-to-openapi pairing; static JSON at
//     /openapi.json + Scalar UI at /docs; route handler still does
//     own Zod parse — generator only publishes contract.
//   • Adding new endpoint 3-step recipe: api-types schemas →
//     registerRoute(...) here → handler.
//   • extendZodWithOpenApi(z) MUST run before any registry.register
//     call.
//   • Bearer auth scheme component.
//   • V-386 AccountMeResponse inline rationale: defined here NOT
//     api-types because it is richer than AccountSchema, then mirrored
//     into named public SDK response models + the dashboard.
//   • Component-promotion rationale: reusable schemas promoted to
//     components.schemas so codegen produces named types (Pydantic
//     / Go structs) instead of inline anonymous shapes.
//   • problemContent + errors4xx 400/401 application/problem+json.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W439.C apps/server/src/lib/openapi.ts content parity', () => {
  const body = read(LIB);

  it('Header framing pinned: OpenAPI 3.1 spec generator; @asteasolutions/zod-to-openapi registry pairs Zod schemas with route metadata (path, method, auth, rate-limit bucket, status codes); static JSON at /openapi.json + Scalar UI at /docs', () => {
    expect(body).toMatch(/\/\/ OpenAPI 3\.1 spec generator\./);
    expect(body).toMatch(
      /\/\/ Builds the API document by registering Zod schemas with @asteasolutions\/\s*\/\/ zod-to-openapi and pairing them with route metadata \(path, method, auth,\s*\/\/ rate-limit bucket, status codes\)\. The output is a static JSON document\s*\/\/ served at \/openapi\.json and rendered by Scalar UI at \/docs\./,
    );
  });

  it('Adding-new-endpoint 3-step recipe framing pinned: (1) define request+response schemas in @driftstack/api-types (2) registerRoute(...) call here (3) route handler in apps/server/src/routes/; route handler still does own Zod parse — generator only publishes contract', () => {
    expect(body).toMatch(
      /\/\/ Adding a new endpoint requires:\s*\/\/\s*1\. Define request \+ response schemas in @driftstack\/api-types\s*\/\/\s*2\. Add a `registerRoute\(\.\.\.\)` call in this file\s*\/\/\s*3\. Add the route handler in apps\/server\/src\/routes\//,
    );
    expect(body).toMatch(
      /\/\/ The route handler still does its own Zod parse — this generator only\s*\/\/ publishes the contract\./,
    );
  });

  it('imports: extendZodWithOpenApi + OpenApiGeneratorV31 + OpenAPIRegistry from @asteasolutions; OpenAPIObject from openapi3-ts/oas31; z from zod; extendZodWithOpenApi(z) BEFORE any registry.register', () => {
    expect(body).toMatch(
      /import \{\s*extendZodWithOpenApi,\s*OpenApiGeneratorV31,\s*OpenAPIRegistry,\s*\} from '@asteasolutions\/zod-to-openapi';/,
    );
    expect(body).toMatch(/import type \{ RouteConfig \} from '@asteasolutions\/zod-to-openapi';/);
    expect(body).toMatch(/import type \{ OpenAPIObject \} from 'openapi3-ts\/oas31';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /\/\/ Augment z with \.openapi\(\) — must run before any registry\.register call\.\s*extendZodWithOpenApi\(z\);/,
    );
  });

  it('V-386 AccountMeResponse inline rationale frames the rich OpenAPI component and SDK/dashboard consumers', () => {
    expect(body).toMatch(
      /\/\/ V-386 — full \/v1\/account\/me response shape\. Defined here rather than\s*\/\/ in api-types because it is richer than the lean shared AccountSchema\.\s*\/\/ This named OpenAPI component is also mirrored by the public SDK\s*\/\/ AccountSelfProfile models and consumed directly by the dashboard\./,
    );
  });

  it('AccountMeResponseSchema shape includes avatar_url plus avatar_source user/idp/none', () => {
    expect(body).toMatch(
      /const AccountMeResponseSchema = z\.object\(\{\s*id: z\.string\(\),\s*email: z\.string\(\)\.email\(\),\s*name: z\.string\(\)\.nullable\(\),\s*tier: AccountTierSchema,\s*status: AccountStatusSchema,\s*timezone: z\.string\(\)\.nullable\(\),\s*slug: z\.string\(\)\.nullable\(\),\s*region: AccountRegionSchema\.nullable\(\),\s*avatar_url: z\.string\(\)\.nullable\(\),\s*avatar_source: z\.enum\(\['user', 'idp', 'none'\]\),\s*mfa_enrolled: z\.boolean\(\),\s*concurrent_session_cap: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*concurrent_session_active: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*profile_cap: z\.number\(\)\.int\(\)\.nonnegative\(\)\.nullable\(\),\s*profile_count: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*teams: z\.array\(/,
    );
  });

  it('AccountMeResponseSchema teams entries carry owner_account_id + owner_email + owner_name nullable + role + membership_id (owner identity for the dashboard team label)', () => {
    expect(body).toMatch(
      /teams: z\.array\(\s*z\.object\(\{\s*owner_account_id: z\.string\(\),(?:\s*\/\/[^\n]*)*\s*owner_email: z\.string\(\),\s*owner_name: z\.string\(\)\.nullable\(\),\s*role: z\.enum\(\['admin', 'member'\]\),\s*membership_id: z\.string\(\),\s*\}\),\s*\),/,
    );
  });

  it('PaginatedSessions + PaginatedApiKeys inline schemas (data array + has_more + next_cursor on sessions; data array only on api-keys)', () => {
    expect(body).toMatch(
      /const PaginatedSessionsSchema = z\.object\(\{\s*data: z\.array\(SessionSchema\),\s*has_more: z\.boolean\(\),\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const PaginatedApiKeysSchema = z\.object\(\{\s*data: z\.array\(ApiKeySchema\),\s*\}\);/,
    );
  });

  it("Bearer auth scheme component (http bearer + bearerFormat 'API key')", () => {
    expect(body).toMatch(
      /r\.registerComponent\('securitySchemes', 'BearerAuth', \{\s*type: 'http',\s*scheme: 'bearer',\s*bearerFormat: 'API key',\s*\}\);/,
    );
  });

  it("Component-promotion rationale framing pinned: reusable schemas promoted to components.schemas so codegen produces named types (Pydantic, Go structs, etc.) instead of inline anonymous shapes; anything referenced from a route's request/response is registered here", () => {
    expect(body).toMatch(
      /\/\/ Reusable schemas — promote to components\.schemas so codegen\s*\/\/ produces named types \(Pydantic, Go structs, etc\.\) instead of\s*\/\/ inline anonymous shapes\. Anything referenced from a route's\s*\/\/ request\/response is registered here\./,
    );
  });

  it('Component registrations: Account + AccountMeResponse + ApiKey + Session + SessionState + Problem + UsagePeriodSummary + PaginationQuery + 5 session-resource action shapes (Create/Navigate/Interact/Wait/Capture) + ApiKey create + Webhook resource shapes + AdminAccount + AdminAuditLogEntry deterministic-order top-level rationale', () => {
    expect(body).toMatch(/r\.register\('Account', AccountSchema\);/);
    expect(body).toMatch(/r\.register\('AccountMeResponse', AccountMeResponseSchema\);/);
    expect(body).toMatch(/r\.register\('Session', SessionSchema\);/);
    expect(body).toMatch(/r\.register\('SessionState', SessionStateSchema\);/);
    expect(body).toMatch(/r\.register\('Problem', ProblemSchema\);/);
    expect(body).toMatch(/r\.register\('UsagePeriodSummary', UsagePeriodSummarySchema\);/);
    expect(body).toMatch(/r\.register\('PaginationQuery', PaginationQuerySchema\);/);
    expect(body).toMatch(
      /\/\/ Sessions resource\s*r\.register\('CreateSessionRequest', CreateSessionRequestSchema\);/,
    );
    expect(body).toMatch(
      /\/\/ API keys resource\s*r\.register\('CreateApiKeyRequest', CreateApiKeyRequestSchema\);/,
    );
    expect(body).toMatch(
      /\/\/ Webhooks resource\s*r\.register\('WebhookEndpoint', WebhookEndpointSchema\);/,
    );
    expect(body).toMatch(
      /\/\/ Admin \(already registered below for the admin section, but having\s*\/\/ them once at the top keeps the codegen output deterministic\)\.\s*r\.register\('AdminAccount', AdminAccountResponseSchema\);\s*r\.register\('AdminAuditLogEntry', AdminAuditLogEntrySchema\);/,
    );
  });

  it('problemContent application/problem+json shape + errors4xx 400/401 entries with Problem $ref', () => {
    expect(body).toMatch(
      /const problemContent = \{\s*'application\/problem\+json': \{ schema: \{ \$ref: '#\/components\/schemas\/Problem' \} \},\s*\};/,
    );
    // SPLIT. The chain ran 400 and 401 as consecutive one-line entries, so
    // declaring the RFC 7235 challenge on the 401 — which makes that entry
    // multi-line — broke a pin about the Problem $ref. Each status is pinned on
    // its own, and the 401's headers get their own assertion rather than being
    // load-bearing for a claim about $ref shape.
    // V-942 — the SPLIT above was made for this exact reason and it happened
    // again: declaring X-Request-Id on the shared error set turned 400 and 403
    // into multi-line entries and merged the 401/429 header objects. Third time
    // this pin family has broken on a header being added, so each status is now
    // pinned to its OWN shape and the header composition is asserted separately
    // rather than being load-bearing for a claim about the Problem $ref.
    expect(body).toMatch(/const errors4xx = \{/);
    expect(body).toMatch(
      /400: \{\s*description: 'Validation failed\.',\s*content: problemContent,\s*headers: requestIdHeader,\s*\},/,
    );
    expect(body).toMatch(
      /403: \{\s*description: 'Caller not permitted\.',\s*content: problemContent,\s*headers: requestIdHeader,\s*\},/,
    );
    expect(body).toMatch(
      /401: \{\s*description: 'Authentication failed\.',\s*content: problemContent,\s*headers: \{ \.\.\.unauthorizedHeaders, \.\.\.requestIdHeader \},\s*\},/,
    );
    // Per-occurrence negative: a status entry that carries no headers at all is
    // the state this replaced, and it would mean the correlation id support asks
    // for is undeclared again on that status.
    expect(body, 'no error status may go back to a headerless one-liner').not.toMatch(
      /400: \{ description: 'Validation failed\.', content: problemContent \},/,
    );
  });

  it('errors4xx 429 declares the rate-limit headers, and 401 the WWW-Authenticate challenge — one shared helper each, so every route inherits them rather than 213 declarations drifting apart', () => {
    expect(body).toMatch(/const rateLimitHeaders = \{/);
    expect(body).toMatch(/'Retry-After': \{/);
    expect(body).toMatch(/const unauthorizedHeaders = \{/);
    expect(body).toMatch(/'WWW-Authenticate': \{/);
    // V-942 — the 429 now merges the shared request-id header with its own set.
    expect(body).toMatch(
      /429: \{\s*description: 'Rate limit or concurrency limit hit\.',\s*content: problemContent,\s*headers: \{ \.\.\.rateLimitHeaders, \.\.\.requestIdHeader \},\s*\},/,
    );
    // V-942 — the legacy X-RateLimit-* aliases are declared, not just described
    // inside the Bucket header's prose.
    expect(body).toMatch(/'X-RateLimit-Limit': \{/);
    expect(body).toMatch(/'X-RateLimit-Remaining': \{/);
    expect(body).toMatch(/'X-RateLimit-Reset': \{/);
    expect(body).toMatch(/const requestIdHeader = \{/);
    expect(body).toMatch(/'X-Request-Id': \{/);
  });

  it('auth security array shorthand for routes: [{ BearerAuth: [] }]', () => {
    expect(body).toMatch(/const auth = \[\{ BearerAuth: \[\] \}\];/);
  });

  it('POST /v1/agent-sessions request body documents all 4 create params incl mode + model — the inline request schema once listed only driftstack_session_id + token_budget, drifting from the route CreateAgentSessionRequestSchema so the #15 model picker + operational mode were invisible to SDK codegen + the published API reference. model references AgentModelSchema (drift-proof: a new/renamed Claude model flows into the spec automatically); the trailing .optional() distinguishes the create body from the non-optional set-mode request body', () => {
    expect(body).toMatch(/model: AgentModelSchema\.optional\(\),/);
    expect(body).toMatch(/mode: z\.enum\(\['manual', 'ai', 'pair'\]\)\.optional\(\),/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
