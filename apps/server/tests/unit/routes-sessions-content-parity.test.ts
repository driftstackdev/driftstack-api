// W437.A — drift guard for apps/server/src/routes/sessions.ts.
// 8 endpoints under /v1/sessions + V-326e team-RBAC role gate.
// Drift here either drops the admin-only Q1 verdict on team-scoped
// writes (team member can write to owner's sessions silently) or
// breaks the L-001 gui_control scope gate on gui-input (coordinate
// primitives bleed onto customer-facing API surface, behavioral
// simulation layer bypassed).
//
//   • Header: X-Driftstack-Account effective-account routing.
//   • sessions:create rate-limit bucket on POST /v1/sessions.
//   • V-326e1 — POST: admin role required when team-scoped; owner's
//     tier drives concurrent cap.
//   • Live driver operations (including state, which exposes cookies and
//     localStorage) require admin role on team; persisted list/detail
//     metadata remains readable by both member and admin.
//   • V-326e2 — DELETE: admin-only on team scope.
//   • L-001 gui_control gate: customer keys never carry; enterprise
//     self-hosted GUI keys do; gui-input bypasses behavioral simulation.
//   • Public-id prefix conversion at route boundary; service+DB use
//     raw uuids.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W437.A apps/server/src/routes/sessions.ts content parity', () => {
  const body = read(LIB);

  it('header doc framing pinned: 8 endpoints; every route auth-gated + rate-limit("global") + sessions:create bucket + Zod parse + public session shape (account/key ids prefixed, driver_session_id stripped) + SessionsService delegate', () => {
    expect(body).toMatch(/\/\/ Session routes — eight endpoints under \/v1\/sessions\./);
    expect(body).toMatch(
      /\/\/ Every route:\s*\n?\s*\/\/\s*- is auth-gated via app\.requireAuth\s*\n?\s*\/\/\s*- is rate-limited via app\.rateLimit\('global'\), session-create gets a\s*\n?\s*\/\/\s*dedicated bucket \(sessions:create\) for tighter throttling\s*\n?\s*\/\/\s*- parses request body\/params\/query through Zod schemas in @driftstack\/api-types\s*\n?\s*\/\/\s*- returns the public session shape \(account\/key ids prefixed, internal\s*\n?\s*\/\/\s*fields like driver_session_id stripped\)\s*\n?\s*\/\/\s*- delegates to SessionsService for business logic/,
    );
    expect(body).toMatch(
      /\/\/ Public id format: `acc_<uuid>`, `key_<uuid>`, `ses_<uuid>`\. The route\s*\n?\s*\/\/ layer is the prefix-conversion boundary; service \+ DB use raw uuids\./,
    );
  });

  it('imports request schemas including strict profile launch + AccountTier from @driftstack/api-types', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*CaptureRequestSchema,\s*\n?\s*ExtractRequestSchema,\s*\n?\s*SearchRequestSchema,\s*\n?\s*SessionLoginRequestSchema,\s*\n?\s*CreateSessionRequestSchema,\s*\n?\s*LaunchProfileRequestSchema,\s*\n?\s*InteractRequestSchema,\s*\n?\s*NavigateRequestSchema,\s*\n?\s*PaginationQuerySchema,\s*\n?\s*WaitRequestSchema,\s*\n?\s*type AccountTier,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{ SessionRecord, SessionsService \} from '\.\.\/services\/sessions\.js';/,
    );
    expect(body).toMatch(/import \{ GUIInputRequestSchema \} from '\.\.\/schemas\/gui-input\.js';/);
    expect(body).toMatch(
      /import \{ BadRequestError, ForbiddenError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountAuthRepo \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(/import \{ resolveEffectiveAccount \} from '\.\.\/services\/auth\.js';/);
  });

  it('readEffectiveAccountHeader imported from shared lib/effective-account-header.ts (extraction collapsed inline EFFECTIVE_ACCOUNT_HEADER + array-or-string handler across team-RBAC routes)', () => {
    expect(body).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(body).toMatch(/readEffectiveAccountHeader\(request\)/);
  });

  it('effectiveAccountIdForLiveOperation gates all nine live-driver routes while persisted metadata reads remain member-readable', () => {
    expect(body).toMatch(
      /\*\s*Resolves the effective account for a live driver operation and enforces\s*\n?\s*\*\s*the team-admin role gate before the service can claim or contact that\s*\n?\s*\*\s*runtime\./,
    );
    expect(body).toMatch(
      /\*\s*Persisted metadata reads \(list \/ describe\) remain available to team\s*\n?\s*\*\s*members and use resolveEffectiveAccount inline\. Live state is deliberately\s*\n?\s*\*\s*different: it exposes cookies and localStorage and owns the driver while\s*\n?\s*\*\s*capturing, so it must use this gate too\./,
    );
    expect(body).toMatch(
      /function effectiveAccountIdForLiveOperation\(\s*\n?\s*request: FastifyRequest,\s*\n?\s*ctx: NonNullable<FastifyRequest\['account'\]>,\s*\n?\s*\): string \| undefined \{\s*\n?\s*const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*\n?\s*if \(effective\.kind !== 'team'\) return undefined;\s*\n?\s*if \(effective\.role !== 'admin'\) \{\s*\n?\s*throw new ForbiddenError\(\s*\n?\s*'Live session operations on a team owner require admin role on that team\.',\s*\n?\s*\);\s*\n?\s*\}\s*\n?\s*return effective\.accountId;\s*\n?\s*\}/,
    );
    const liveRoutes = [
      ['/v1/sessions/:id/navigate', 'navigate'],
      ['/v1/sessions/:id/interact', 'interact'],
      ['/v1/sessions/:id/gui-input', 'guiInput'],
      ['/v1/sessions/:id/wait', 'wait'],
      ['/v1/sessions/:id/state', 'getState'],
      ['/v1/sessions/:id/capture', 'capture'],
      ['/v1/sessions/:id/extract', 'extract'],
      ['/v1/sessions/:id/search', 'search'],
      ['/v1/sessions/:id/login', 'login'],
    ] as const;
    for (const [path, serviceMethod] of liveRoutes) {
      const start = body.indexOf(`'${path}'`);
      expect(start, `${path} route exists`).toBeGreaterThan(-1);
      const nextRoute = body.indexOf('\n  // ──', start + path.length);
      const block = body.slice(start, nextRoute === -1 ? body.length : nextRoute);
      const gate = 'const eff = effectiveAccountIdForLiveOperation(request, ctx);';
      const serviceCall = `await service.${serviceMethod}(`;
      expect(block.match(/effectiveAccountIdForLiveOperation\(request, ctx\)/g), path).toHaveLength(
        1,
      );
      expect(block.indexOf(gate), `${path} authority gate`).toBeGreaterThan(-1);
      expect(block.indexOf(serviceCall), `${path} service call`).toBeGreaterThan(
        block.indexOf(gate),
      );
      expect(block, `${path} effective owner delivery`).toContain(
        'eff !== undefined ? { effectiveAccountId: eff } : {}',
      );
    }
    expect(body).not.toContain('effectiveAccountIdForWrite');
  });

  it('login route mirrors the exact submitted/truncated union and cannot leak a URL from refusal', () => {
    const start = body.indexOf("'/v1/sessions/:id/login'");
    const end = body.indexOf('\n  // ── DELETE', start);
    const block = body.slice(start, end);
    expect(block).toContain('if (!result.submitted) {');
    expect(block).toMatch(
      /submitted: false as const,\s*credentials_truncated: true as const,\s*logged_in: false as const,\s*duration_ms: result\.durationMs,/,
    );
    expect(block).toMatch(
      /submitted: true as const,\s*credentials_truncated: false as const,\s*logged_in: result\.loggedIn,/,
    );
    expect(block.match(/post_login_url/g)).toHaveLength(1);
  });

  it('search route mirrors the exact normal/truncated union and cannot leak visibility from refusal', () => {
    const start = body.indexOf("'/v1/sessions/:id/search'");
    const end = body.indexOf('\n  // ── POST /v1/sessions/:id/login', start);
    const block = body.slice(start, end);
    expect(block).toContain('if (result.queryTruncated) {');
    expect(block).toMatch(
      /submitted: false as const,\s*query_truncated: true as const,\s*duration_ms: result\.durationMs,/,
    );
    expect(block).toMatch(/submitted: result\.submitted,\s*query_truncated: false as const,/);
    expect(block.match(/results_visible/g)).toHaveLength(1);
  });

  it('PUBLIC_ID_RE regex (3-letter prefix + UUID) + uuidFromPrefixedId (validates expectedPrefix) + prefixId helper', () => {
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
    expect(body).toMatch(
      /function uuidFromPrefixedId\(value: string, expectedPrefix: string\): string \{\s*\n?\s*const match = PUBLIC_ID_RE\.exec\(value\);\s*\n?\s*if \(!match \|\| !match\[1\] \|\| !value\.startsWith\(`\$\{expectedPrefix\}_`\)\) \{\s*\n?\s*throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\);\s*\n?\s*\}\s*\n?\s*return match\[1\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function prefixId\(prefix: string, uuid: string\): string \{\s*\n?\s*return `\$\{prefix\}_\$\{uuid\}`;\s*\n?\s*\}/,
    );
  });

  it('publicSession mapper: 13 fields wire (id ses_ + account_id acc_ + api_key_id key_ + status + archetype + purpose + label + metadata + egress_capabilities (migration 0045) + egress_capability_report (Arc 5 EGRESS eg.1 migration 0054) + 4 timestamps incl. nullable last_state_at/destroyed_at)', () => {
    expect(body).toMatch(
      /function publicSession\(s: SessionRecord\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*id: prefixId\('ses', s\.id\),\s*\n?\s*account_id: prefixId\('acc', s\.accountId\),\s*\n?\s*api_key_id: prefixId\('key', s\.apiKeyId\),\s*\n?\s*status: s\.status,\s*\n?\s*archetype: s\.archetype,\s*\n?\s*purpose: s\.purpose,\s*\n?\s*label: s\.label,\s*\n?\s*metadata: s\.metadata,\s*\n?\s*[\s\S]*?egress_capabilities: s\.egressCapabilities,\s*\n?\s*[\s\S]*?egress_capability_report: s\.egressCapabilityReport,\s*\n?\s*created_at: s\.createdAt\.toISOString\(\),\s*\n?\s*updated_at: s\.updatedAt\.toISOString\(\),\s*\n?\s*last_state_at: s\.lastStateAt \? s\.lastStateAt\.toISOString\(\) : null,\s*\n?\s*destroyed_at: s\.destroyedAt \? s\.destroyedAt\.toISOString\(\) : null,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('SessionRoutesOptions retains the authRepo registration seam while live owner tier/override authority is centralized in the limiter', () => {
    expect(body).toMatch(
      /\*\s*V-326e1 — retained as the route-registration authority seam while\s*\n?\s*\*\s*effective-owner tier\/override consumption is centralized in the limiter\./,
    );
    expect(body).toMatch(
      /export interface SessionRoutesOptions \{\s*\n?\s*service: SessionsService;[\s\S]*?authRepo: AccountAuthRepo;[\s\S]*?egressProxyRequired\?: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /import \{ consumeEffectiveOwnerRateLimit \} from '\.\.\/middleware\/rate-limit\.js';/,
    );
    expect(body).toContain('const { service } = opts;');
    expect(body).not.toMatch(/authRepo\.getAccount/);
  });

  it('direct-session egress boundary rejects raw proxy and required-egress posture before either request parser or side effects', () => {
    expect(body).toMatch(/LaunchProfileRequestSchema,/);
    expect(body).toMatch(/const DIRECT_SESSION_EGRESS_GUIDANCE =/);
    expect(body).toMatch(/function assertDirectSessionEgressAvailable\(/);
    expect(body).toMatch(/Object\.prototype\.hasOwnProperty\.call\(rawBody, 'proxy'\)/);
    expect(body).toMatch(/raw proxy field is not supported/);
    expect(body).toMatch(/owned saved proxy_id/);
    expect(body).toMatch(
      /const rawBody = request\.body \?\? \{\};[\s\S]{0,500}?assertDirectSessionEgressAvailable\(rawBody, egressProxyRequired\);\s*\n?\s*const body = CreateSessionRequestSchema\.parse\(rawBody\);/,
    );
    expect(body).toMatch(
      /assertDirectSessionEgressAvailable\(rawBody, egressProxyRequired\);\s*\n?\s*const launchBody = LaunchProfileRequestSchema\.parse\(rawBody\);[\s\S]{0,1800}?const binding = await resolveProfileBinding/,
    );
    expect(body).toMatch(/label: launchBody\.label,/);
    expect(body).not.toMatch(/rawBody\.proxy/);
  });

  it("V-326e1 POST /v1/sessions framing pinned: X-Driftstack-Account → new session on OWNER's account; caller role MUST be admin on that team (Q1 — member is read-only on writes); member role 403; tier-derived concurrent cap uses OWNER tier", () => {
    expect(body).toMatch(
      /\/\/ V-326e1 — when X-Driftstack-Account is set, the new session is\s*\n?\s*\/\/ created on the OWNER's account\. Caller's role MUST be 'admin' on\s*\n?\s*\/\/ that team \(Q1 verdict — member is read-only on writes\); 'member'\s*\n?\s*\/\/ role gets 403\. Tier-derived concurrent cap uses the OWNER's tier\./,
    );
    expect(body).toMatch(/app\.post\(\s*\n?\s*'\/v1\/sessions',/);
    // prettier may wrap the preHandler array multi-line once requireScope
    // is added; \s* spans the newlines either way.
    expect(body).toMatch(
      /preHandler: \[\s*app\.requireAuth,\s*app\.requireScope\('write:sessions'\),\s*app\.rateLimit\('sessions:create'\),?\s*\]/,
    );
    expect(body).toMatch(
      /throw new ForbiddenError\(\s*\n?\s*'Creating a session on a team owner requires admin role on that team\.',\s*\n?\s*\);/,
    );
    // 2026-05-20 — profile_id binding lifted out of the branch as
    // bodyWithProfile; the create call now references bodyWithProfile.
    // doc-150 item 6 — the OWNER's tier is resolved up front (ownerTier) so
    // the storage-quota gate + concurrent cap share it; the team-create call
    // references ownerAccountId + ownerTier (the owner lookup moved ahead of
    // the binding).
    expect(body).toMatch(
      /created = await service\.create\(ctx, bodyWithProfile, \{\s*\n?\s*effectiveAccountId: ownerAccountId,\s*\n?\s*effectiveTier: ownerTier,\s*\n?\s*\.\.\.\(profileBinding !== null \? \{ inheritedProfileArchetype: true \} : \{\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/return reply\.code\(201\)\.send\(publicSession\(created\)\);/);
  });

  it('profile-backed creates explicitly preserve stored legacy archetypes while direct creates stay registry-gated', () => {
    expect(body).toContain(
      '...(profileBinding !== null ? { inheritedProfileArchetype: true } : {}),',
    );
    expect(body).toContain('profileBinding !== null ? { inheritedProfileArchetype: true } : {},');
    expect(body).toMatch(
      /created = await service\.create\(ctx, body, \{\s*effectiveAccountId: ownerAccountId,\s*effectiveTier: ownerTier,\s*inheritedProfileArchetype: true,\s*\}\);/,
    );
    expect(body).toContain(
      'created = await service.create(ctx, body, { inheritedProfileArchetype: true });',
    );
  });

  it('V-326d GET /v1/sessions framing pinned: honors X-Driftstack-Account — team member with valid membership sees owner sessions; without header behaves identically to pre-V-326d; response data + has_more (nextCursor !== null) + next_cursor', () => {
    expect(body).toMatch(
      /\/\/ V-326d — honors X-Driftstack-Account: a team member with a valid\s*\n?\s*\/\/ membership on the requested owner sees the owner's sessions\.\s*\n?\s*\/\/ Without the header \(or with the caller's own account id\), behaves\s*\n?\s*\/\/ identically to pre-V-326d\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*data: page\.items\.map\(publicSession\),\s*\n?\s*has_more: page\.nextCursor !== null,\s*\n?\s*next_cursor: page\.nextCursor,\s*\n?\s*\};/,
    );
  });

  it('V-326e3 POST /v1/sessions/:id/navigate: NavigateRequestSchema + live-operation gate + response (url + final_url + status + duration_ms snake_case)', () => {
    expect(body).toMatch(
      /\/\/ ── POST \/v1\/sessions\/:id\/navigate ─[\s\S]*?\/\/ V-326e3 — admin-only when targeting an owner via X-Driftstack-\s*\n?\s*\/\/ Account; member role gets 403\./,
    );
    expect(body).toMatch(/const body = NavigateRequestSchema\.parse\(request\.body \?\? \{\}\);/);
    expect(body).toMatch(
      /return \{\s*\n?\s*url: result\.url,\s*\n?\s*final_url: result\.finalUrl,\s*\n?\s*status: result\.status,\s*\n?\s*duration_ms: result\.durationMs,\s*\n?\s*\};/,
    );
  });

  it('L-001 framing pinned on /v1/sessions/:id/gui-input: GUI-control plane coordinate-level primitives bypass behavioral-simulation layer; gated behind gui_control scope; customer keys never carry; only enterprise self-hosted GUI keys do; V-326e3 admin-only on team', () => {
    expect(body).toMatch(
      /\/\/ GUI-control plane \(L-001\)\. Coordinate-level primitives that bypass\s*\n?\s*\/\/ the behavioral simulation layer\. Gated behind `gui_control` scope —\s*\n?\s*\/\/ customer keys never carry this; only enterprise self-hosted GUI\s*\n?\s*\/\/ keys do\. See docs\/locked-decisions\.md\./,
    );
    expect(body).toMatch(
      /preHandler: \[app\.requireAuth, app\.requireScope\('gui_control'\), app\.rateLimit\('global'\)\],/,
    );
    expect(body).toMatch(/const body = GUIInputRequestSchema\.parse\(request\.body \?\? \{\}\);/);
  });

  it('getState retains read:sessions but requires team-admin live-operation authority before service/driver contact', () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/sessions\/:id\/state',[\s\S]{0,300}?preHandler: \[app\.requireAuth, app\.requireScope\('read:sessions'\), app\.rateLimit\('global'\)\],[\s\S]{0,300}?const eff = effectiveAccountIdForLiveOperation\(request, ctx\);\s*\n?\s*await consumeEffectiveOwnerRateLimit\(app, request, reply, eff \?\? ctx\.account\.id, 'global'\);\s*\n?\s*const state = await service\.getState\(\s*\n?\s*ctx,\s*\n?\s*id,\s*\n?\s*eff !== undefined \? \{ effectiveAccountId: eff \} : \{\},\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      // W615 — page_state (lifecycle for pollers) sits between local_storage
      // and captured_at; the comment line is matched loosely.
      /return \{\s*\n?\s*url: state\.url,\s*\n?\s*title: state\.title,\s*\n?\s*cookies: state\.cookies,\s*\n?\s*local_storage: state\.localStorage,[\s\S]{0,200}?page_state: state\.pageState,\s*\n?\s*captured_at: state\.capturedAt\.toISOString\(\),\s*\n?\s*\};/,
    );
  });

  it('session list rejects insufficient scope before actor or selected-owner rate-limit consumption', () => {
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/sessions',\s*\n?\s*\{\s*\n?\s*preHandler: \[app\.requireAuth, app\.requireScope\('read:sessions'\), app\.rateLimit\('global'\)\],\s*\n?\s*\},[\s\S]{0,300}?const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*\n?\s*await consumeEffectiveOwnerRateLimit\(app, request, reply, effective\.accountId, 'global'\);/,
    );
  });

  it('V-326e3 capture WRITE rationale pinned: mutates driver state via screenshot/snapshot ops + records billed events; admin-only on team-scoped; CaptureRequestSchema + response (kind + data + encoding + byte_size + duration_ms)', () => {
    expect(body).toMatch(
      /\/\/ V-326e3 — capture is a WRITE \(it mutates the driver state via\s*\n?\s*\/\/ screenshot\/snapshot ops \+ records billed events\)\. Admin-only on\s*\n?\s*\/\/ team-scoped requests\./,
    );
    expect(body).toMatch(/const body = CaptureRequestSchema\.parse\(request\.body \?\? \{\}\);/);
    expect(body).toMatch(
      /return \{\s*\n?\s*kind: result\.kind,\s*\n?\s*data: result\.data,\s*\n?\s*encoding: result\.encoding,\s*\n?\s*byte_size: result\.byteSize,\s*\n?\s*duration_ms: result\.durationMs,\s*\n?\s*\};/,
    );
  });

  it('V-326e2 DELETE /v1/sessions/:id: admin-only when targeting an owner via X-Driftstack-Account; member role 403; self-account behavior unchanged; 204 No Content on success', () => {
    expect(body).toMatch(
      /\/\/ V-326e2 — admin-only when targeting an owner via X-Driftstack-\s*\n?\s*\/\/ Account; member role gets 403\. Self-account behavior unchanged\./,
    );
    expect(body).toMatch(
      /if \(effective\.kind === 'team' && effective\.role !== 'admin'\) \{\s*\n?\s*throw new ForbiddenError\(\s*\n?\s*'Destroying a session on a team owner requires admin role on that team\.',\s*\n?\s*\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/return reply\.code\(204\)\.send\(\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
