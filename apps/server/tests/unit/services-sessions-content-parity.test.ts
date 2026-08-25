// W404.C — drift guard for apps/server/src/services/sessions.ts.
// Sessions service — owns concurrent-session limits + driver-call
// failure capture + V-326 team RBAC fan-out semantics. Drift here
// either breaks tier cap enforcement (over-limit session creation)
// or scrambles V-326e webhook/audit fan-out direction (events go
// to wrong audience).
//
//   • Account-scoped ownership invariant pinned: session belongs
//     to exactly one account.
//   • concurrentSessionLimitFor: TIER_CONCURRENT_SESSION_LIMITS
//     (V-156) single-source-of-truth helper.
//   • profileLimitFor: PROFILES_PER_TIER (V-136) — translates
//     'custom' enterprise sentinel to null for legacy null-means-
//     unlimited contract.
//   • SessionRecord: 13 fields + 5-status union ('creating' |
//     'ready' | 'busy' | 'destroyed' | 'errored') + migration 0045
//     egressCapabilities JSONB (cross-agent contract 7d5992d9).
//   • SessionEventInput.type: 9-literal union covering full
//     lifecycle (created → navigated/interacted/gui_input/waited/
//     state_captured/screenshot_captured → destroyed/errored).
//   • V-326e1 create: tier cap on OWNER's account (effectiveAccount
//     opts); ConcurrencyLimitError when active >= limit.
//   • V-202c first-failure email + V-304a first-success email
//     dedup at lifecycle service.
//   • destroy V-167: serialized repository outcome elects one
//     driver/status/event winner across every destroy source.
//   • V-090 errored = destroyed for customer (subsequent ops 410);
//     terminal short-circuit in requireOwned.
//   • V-326e3 runWithFailureCapture: session.failed webhook +
//     V-202c first-failure email fan out to session.accountId
//     (OWNER, NOT caller); audit row on OWNER's log with actor
//     stays member.
//   • listAll: driftstack_internal_admin scope (V-174 'admin'
//     compat alias for legacy keys).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W404.C apps/server/src/services/sessions.ts content parity', () => {
  const body = read(LIB);

  it('Account-scoped ownership invariant pinned: session belongs to exactly one account', () => {
    expect(body).toMatch(
      /Every method takes an AccountContext and enforces account-scoped ownership\s*\/\/\s*— a session belongs to exactly one account, and only that account's keys\s*\/\/\s*can operate on it\./,
    );
  });

  it('concurrentSessionLimitFor: TIER_CONCURRENT_SESSION_LIMITS V-156 single-source-of-truth helper', () => {
    expect(body).toMatch(
      /\/\/ Single source of truth lives in api-types\s*\/\/ \(TIER_CONCURRENT_SESSION_LIMITS, V-156\)\./,
    );
    expect(body).toMatch(
      /export function concurrentSessionLimitFor\(tier: AccountTier\): number \{\s*return TIER_CONCURRENT_SESSION_LIMITS\[tier\];\s*\}/,
    );
  });

  it("profileLimitFor: PROFILES_PER_TIER V-136 — 'custom' enterprise sentinel → null for legacy unlimited contract", () => {
    expect(body).toMatch(
      /\/\/ Profile count limit per tier — enforced at the \/v1\/profiles\s*\/\/ creation gate\. Single source of truth lives in api-types\s*\/\/ \(PROFILES_PER_TIER, V-136\)\. The api-types record uses the\s*\/\/ 'custom' sentinel for enterprise; this helper translates to\s*\/\/ null for the legacy null-means-unlimited contract/,
    );
    expect(body).toMatch(
      /export function profileLimitFor\(tier: AccountTier\): number \| null \{\s*const limit = PROFILES_PER_TIER\[tier\];\s*return limit === 'custom' \? null : limit;\s*\}/,
    );
  });

  it("SessionRecord: 13 fields + 5-status union ('creating'|'ready'|'busy'|'destroyed'|'errored') + V-169 purpose + migration 0045 egressCapabilities", () => {
    expect(body).toMatch(/export interface SessionRecord \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/apiKeyId: string;/);
    expect(body).toMatch(/driverSessionId: string;/);
    expect(body).toMatch(/status: 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/);
    expect(body).toMatch(/archetype: string;/);
    expect(body).toMatch(/\/\*\* V-169 — harness purpose\. \*\/\s*purpose: SessionPurpose;/);
    expect(body).toMatch(/label: string \| null;/);
    expect(body).toMatch(/metadata: Record<string, unknown> \| null;/);
    expect(body).toMatch(
      /egressCapabilities: \{\s*udp_associate: boolean;\s*quic_route: 'proxy' \| 'direct' \| 'disabled';\s*dns_remote_resolve: boolean;\s*warnings: string\[\];\s*\} \| null;/,
    );
    expect(body).toMatch(/lastStateAt: Date \| null;/);
    expect(body).toMatch(/destroyedAt: Date \| null;/);
  });

  it('W487 navigate() service-level scheme guard pinned — http/https only, BEFORE requireOwned/driver dispatch. The agent executor calls this service directly (bypasses the route schema), so a prompt-injected file:///ftp: navigate must be rejected here. Drift to dropping it reopens the agent-path scheme hole.', () => {
    expect(body).toMatch(
      /if \(!\/\^https\?:\\\/\\\/\/i\.test\(body\.url\)\) \{\s*throw new BadRequestError\('Only http:\/\/ and https:\/\/ URLs can be navigated\.'\);\s*\}/,
    );
  });

  it('SessionEventInput.type: 9-literal lifecycle union', () => {
    expect(body).toMatch(/export interface SessionEventInput \{/);
    expect(body).toMatch(
      /type:\s*\| 'created'\s*\| 'navigated'\s*\| 'interacted'\s*\| 'gui_input'\s*\| 'waited'\s*\| 'state_captured'\s*\| 'screenshot_captured'\s*\| 'destroyed'\s*\| 'errored';/,
    );
  });

  it('SessionRepo methods include one serialized destroy authority shared by customer/admin/system callers', () => {
    expect(body).toMatch(/export interface SessionRepo \{/);
    expect(body).toMatch(/insertSession\(input: NewSessionInput\): Promise<SessionRecord>;/);
    // The atomic insert-if-under-cap (TOCTOU fix) is part of the contract.
    // Reflow-robust: prettier collapses this signature to one line (no
    // trailing comma), so match space-or-newline + an optional trailing comma.
    // A3 finding #7 (W2979/W2980) — gained the optional `opts.profileId` arg for
    // the single-active-session-per-profile guard.
    expect(body).toMatch(
      /insertSessionIfUnderLimit\(\s*input: NewSessionInput,\s*limit: number,\s*opts\?: \{ profileId\?: string \},?\s*\): Promise<SessionRecord \| null>;/,
    );
    // DoS hardening — activate exactly the still-live reservation after the
    // create flow reserves the cap slot BEFORE slow worker dispatch.
    expect(body).toMatch(
      /activateSessionReservation\(input: \{\s*id: string;\s*reservationDriverSessionId: string;\s*driverSessionId: string;\s*\}\): Promise<SessionRecord \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Find a session by id, scoped to the supplied account\. \*\/\s*findSession\(id: string, accountId: string\): Promise<SessionRecord \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Find a session by id WITHOUT account scoping \(admin force-actions only\)\. \*\/\s*findSessionUnscoped\(id: string\): Promise<SessionRecord \| null>;/,
    );
    expect(body).toMatch(
      /export interface SerializedSessionDestroyInput \{[\s\S]+?accountId: string \| null;[\s\S]+?destroyedAt: Date;[\s\S]+?event: Omit<SessionEventInput, 'sessionId' \| 'type'> & \{ type: 'destroyed' \};/,
    );
    expect(body).toMatch(
      /export type SerializedSessionDestroyResult =\s*\| \{ kind: 'destroyed' \| 'already_terminal'; session: SessionRecord \}\s*\| \{ kind: 'driver_error'; session: SessionRecord; error: unknown \}\s*\| \{ kind: 'not_found' \};/,
    );
    expect(body).toMatch(
      /destroySessionSerialized\(\s*input: SerializedSessionDestroyInput,\s*destroyDriverSession: \(session: SessionRecord\) => Promise<void>,\s*\): Promise<SerializedSessionDestroyResult>;/,
    );
    expect(body).toMatch(/countActiveSessions\(accountId: string\): Promise<number>;/);
    expect(body).toMatch(
      /countAllByStatus\(\): Promise<Record<SessionRecord\['status'\], number>>;/,
    );
    expect(body).toMatch(
      /listSessions\(\s*accountId: string,\s*opts: \{ limit: number; cursor\?: string \},\s*\): Promise<SessionListPage>;/,
    );
    expect(body).toMatch(/listAllSessions\(opts: \{/);
    expect(body).toMatch(/recordEvent\(input: SessionEventInput\): Promise<void>;/);
    // 6.g — duration auto-destroy sweep query.
    expect(body).toMatch(/listExpiredForAutoDestroy\(opts: \{/);
    expect(body).toMatch(
      /tierCutoffs: ReadonlyArray<\{ tier: AccountTier; expiredBefore: Date \}>;/,
    );
  });

  it('statsForAdmin: scope-gated cross-account session stats — by_status + active (creating+ready+busy) + total', () => {
    expect(body).toMatch(/async statsForAdmin\(ctx: AccountContext\): Promise<\{/);
    expect(body).toMatch(/const byStatus = await this\.deps\.repo\.countAllByStatus\(\);/);
    expect(body).toMatch(/const active = byStatus\.creating \+ byStatus\.ready \+ byStatus\.busy;/);
    expect(body).toMatch(/const total = active \+ byStatus\.destroyed \+ byStatus\.errored;/);
  });

  it('SessionsServiceDeps: 4 fields — repo + driver + V-216 accountAudit (session.created/destroyed only) + V-202c/V-304a accountLifecycle', () => {
    expect(body).toMatch(/export interface SessionsServiceDeps \{/);
    expect(body).toMatch(/repo: SessionRepo;/);
    expect(body).toMatch(/driver: Driver;/);
    expect(body).toMatch(
      /webhooks\?: \{\s*enqueueEvent: \(\s*accountId: string,\s*eventType: 'session\.completed' \| 'session\.failed' \| 'session\.egress_capability_changed',/,
    );
    expect(body).toMatch(
      /\/\*\* V-216: optional customer-facing audit emitter\. \*\/\s*accountAudit\?: \{[\s\S]+?action: 'session\.created' \| 'session\.destroyed';/,
    );
    expect(body).toMatch(
      /V-202c: optional lifecycle dispatcher\. When wired, the first\s*\*\s*session\.failed for an account triggers `session-failed-first`\s*\*\s*email \(deduped via `accounts\.first_failure_email_sent_at`\)\./,
    );
    expect(body).toMatch(
      /event:\s*\| \{ kind: 'session\.failed\.first'; sessionId: string; errorMessage: string \}\s*\| \{ kind: 'session\.success\.first'; sessionId: string \},/,
    );
    // 2026-05-20 — NotificationEventBus publisher for session.errored
    // pinned (third bus publisher alongside cost-alert + audit.high_
    // severity). Drift on the shape breaks the GUI panel toast for
    // driver failures.
    expect(body).toMatch(/notifications\?: \{\s*publish: \(event: \{\s*kind: 'session\.errored';/);
  });

  it('V-326e1 create: cap on OWNER account via effectiveAccountId opt', () => {
    expect(body).toMatch(
      /\/\/ V-326e1 — when effectiveAccountId is set \(route layer resolved\s*\/\/ X-Driftstack-Account \+ verified the caller has 'admin' role on\s*\/\/ the owner's team\), the new session is OWNED by the team owner\s*\/\/ and counts against the OWNER's concurrent cap\./,
    );
    expect(body).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
    expect(body).toMatch(/const limit = concurrentSessionLimitFor\(tier\);/);
  });

  it('create (DoS hardening): reserve precedes dispatch and one exact CAS binds the real id + ready; a destroy winner is cleaned up and never published ready', () => {
    // The whole fix: reserve-first so an over-cap / failed create never spins
    // a worker (no orphan to best-effort-teardown). Pin the ordering + the
    // reservation placeholder + dispatch-failure release + atomic activation.
    expect(body).toMatch(/const reservationDriverId = `reserving:\$\{randomUUID\(\)\}`;/);
    expect(body).toMatch(/const reserved = await this\.deps\.repo\.insertSessionIfUnderLimit\(/);
    // The reservation insert precedes the worker dispatch in source order.
    const reserveIdx = body.indexOf('insertSessionIfUnderLimit(');
    const dispatchIdx = body.indexOf('await this.deps.driver.createSession({');
    expect(reserveIdx).toBeGreaterThan(0);
    expect(dispatchIdx).toBeGreaterThan(reserveIdx);
    expect(body).toMatch(
      /if \(reserved === null\) \{[\s\S]*?throw new ConcurrencyLimitError\(limit, limit\);/,
    );
    // Dispatch failure releases the reservation row (errored + destroyedAt).
    expect(body).toMatch(
      /\.updateSessionStatus\(reserved\.id, 'errored', \{ destroyedAt: new Date\(\) \}\)/,
    );
    // Real driver id + ready status are committed by one exact-reservation CAS.
    expect(body).toMatch(
      /const activated = await this\.deps\.repo\.activateSessionReservation\(\{\s*id: reserved\.id,\s*reservationDriverSessionId: reservationDriverId,\s*driverSessionId: driverResult\.driverSessionId,\s*\}\);/,
    );
    // A destroy/expiry/suspension winner makes the CAS return null: bounded
    // cleanup targets the newly-created real worker, then the typed 410 wins.
    expect(body).toMatch(
      /if \(activated === null\) \{[\s\S]*?destroyDriverSessionWithTimeout\(\(\) =>[\s\S]*?this\.deps\.driver\.destroy\(driverResult\.driverSessionId\)[\s\S]*?throw new SessionDestroyedError\(\);/,
    );
  });

  it('create: archetype = body.archetype ?? LOCKED_ARCHETYPE_ID; purpose = body.purpose ?? DEFAULT_SESSION_PURPOSE; emits session.created audit', () => {
    expect(body).toMatch(/const archetype = body\.archetype \?\? LOCKED_ARCHETYPE_ID;/);
    expect(body).toMatch(
      /const purpose: SessionPurpose = body\.purpose \?\? DEFAULT_SESSION_PURPOSE;/,
    );
    expect(body).toMatch(
      /const accountAuditInput = \{[\s\S]+?action: 'session\.created' as const,\s*targetResourceId: `ses_\$\{record\.id\}`,\s*payload: \{ archetype, purpose \},\s*\};[\s\S]+?\(\) => accountAudit\.record\(accountAuditInput\)/,
    );
  });

  it('V-167 destroy: serialized customer-scoped outcome preserves not-found, idempotent terminal, and original driver-error semantics', () => {
    expect(body).toMatch(
      /\/\/ V-167 — true idempotent destroy\. Pre-V-167 this called requireOwned\(\)\s*\/\/ which threw SessionDestroyedError \(HTTP 410\) on already-destroyed\s*\/\/ sessions before the early-return short-circuit could run\./,
    );
    expect(body).toMatch(/const outcome = await this\.deps\.repo\.destroySessionSerialized\(/);
    expect(body).toMatch(/id: sessionId,\s*accountId,\s*destroyedAt,/);
    expect(body).toMatch(
      /destroyDriverSessionWithTimeout\(\(\) =>\s*this\.deps\.driver\.destroy\(current\.driverSessionId\)\)/,
    );
    expect(body).toMatch(/if \(outcome\.kind === 'not_found'\) \{/);
    expect(body).toMatch(/if \(outcome\.kind === 'already_terminal'\) return;/);
    expect(body).toMatch(/if \(outcome\.kind === 'driver_error'\) throw outcome\.error;/);
  });

  it('all system destroy paths consume the same serialized authority before winner-only fan-out', () => {
    const methodCalls = body.match(/this\.deps\.repo\.destroySessionSerialized\(/g) ?? [];
    expect(methodCalls).toHaveLength(3);
    expect(body).toMatch(/async autoDestroyExpired\([\s\S]+?destroySessionSerialized\(/);
    expect(body).toMatch(/async destroyAllForAccount\([\s\S]+?destroySessionSerialized\(/);
    expect(body).toMatch(/outcome\.kind === 'not_found' \|\| outcome\.kind === 'already_terminal'/);
  });

  it('serialized destroy driver callbacks are bounded at 30 seconds so a hung teardown cannot retain the row lock indefinitely', () => {
    expect(body).toContain('export const SESSION_DESTROY_DRIVER_TIMEOUT_MS = 30_000;');
    expect(body).toMatch(/export async function destroyDriverSessionWithTimeout\(/);
    expect(body).toMatch(/await Promise\.race\(\[destroy\(\), timeout\]\);/);
    expect(body).toContain("new Error('Session driver destroy timed out.')");
    const boundedCalls = body.match(/destroyDriverSessionWithTimeout\(/g) ?? [];
    // One declaration + two post-dispatch create cleanups + customer destroy +
    // duration sweep + suspension reclaim + driver-operation failure cleanup.
    expect(boundedCalls).toHaveLength(7);
    expect(body).toMatch(
      /const failed = await this\.deps\.repo\.failSessionOperation\([\s\S]+?const workerDestroyed = await destroyDriverSessionWithTimeout\(\(\) =>\s*this\.deps\.driver\.destroy\(session\.driverSessionId\),\s*\)\s*\.then\(\(\) => true\)\s*\.catch\(\(\) => false\);/,
    );
    // The teardown OUTCOME must stay captured. This is the only thing that ever
    // reaps the browser on this path — the row is already a tombstone, the
    // duration sweeper reaps only ACTIVE statuses, and destroy() short-circuits
    // 'errored'. While the result was discarded, a permanent leak produced the
    // same signal as a clean teardown: none.
    expect(body).toMatch(
      /if \(!workerDestroyed\) \{[\s\S]{0,600}?event: 'errored_session_worker_teardown_failed',/,
    );
  });

  it('destroy: emits session.completed webhook + V-304a session.success.first email + V-216 session.destroyed audit all try/catch swallow', () => {
    expect(body).toMatch(
      /await this\.deps\.webhooks\.enqueueEvent\(accountId, 'session\.completed', \{\s*session_id: `ses_\$\{session\.id\}`,\s*duration_ms: durationMs,\s*\}\);/,
    );
    expect(body).toMatch(
      /\/\/ V-304a — first-success activation email\.[\s\S]+?await this\.deps\.accountLifecycle\.emit\(accountId, \{\s*kind: 'session\.success\.first',\s*sessionId: `ses_\$\{session\.id\}`,\s*\}\);/,
    );
    expect(body).toMatch(
      /action: 'session\.destroyed',\s*targetResourceId: `ses_\$\{session\.id\}`,\s*payload: \{ duration_ms: durationMs \},/,
    );
  });

  it('direct operations map a terminal atomic claim to SessionDestroyedError 410', () => {
    expect(body).toMatch(/const claim = await this\.deps\.repo\.claimSessionOperation\(/);
    expect(body).toContain("if (claim.kind === 'terminal') throw new SessionDestroyedError();");
  });

  it('V-531.B findOwnedSessionLite: pure ownership check without driver side-effects, returns null on terminal-state sessions instead of throwing (route-friendly contract)', () => {
    expect(body).toMatch(
      /V-531\.B — pure ownership check for routes that only need to know\s*\* "does this account own this session" without claiming a direct driver\s*\* operation\. Returns the row when\s*\* owned \+ not in a terminal state, null otherwise\./,
    );
    expect(body).toMatch(
      /async findOwnedSessionLite\(accountId: string, sessionId: string\): Promise<SessionRecord \| null> \{/,
    );
    expect(body).toMatch(
      /const session = await this\.deps\.repo\.findSession\(sessionId, accountId\);/,
    );
    expect(body).toMatch(
      /if \(session\.status === 'destroyed' \|\| session\.status === 'errored'\) return null;/,
    );
  });

  it("V-326e3 runWithFailureCapture: session.failed webhook + V-202c first-failure email fan-out to session.accountId (OWNER, not caller); audit on OWNER's log", () => {
    expect(body).toMatch(
      /\/\/ V-326e3 — fan-out goes to the SESSION OWNER \(session\.accountId\),\s*\/\/ not the caller\. When a member fails on an owner's session,\s*\/\/ the owner's webhook subscription fires \+ the owner gets the\s*\/\/ first-failure email\. The caller is the actor; the resource's\s*\/\/ owner is the audience\./,
    );
    expect(body).toMatch(
      /const failedData = projectSessionFailedData\(\{\s*session_id: `ses_\$\{session\.id\}`,\s*duration_ms: durationMs,\s*operation,\s*failure_class: failureClass,\s*\}\);/,
    );
    expect(body).toMatch(
      /await this\.deps\.webhooks\.enqueueEvent\(session\.accountId, 'session\.failed', failedData\);/,
    );
    expect(body).toMatch(
      /await this\.deps\.accountLifecycle\.emit\(session\.accountId, \{\s*kind: 'session\.failed\.first',\s*sessionId: `ses_\$\{session\.id\}`,\s*errorMessage: failureCopy\.error_message,\s*\}\);/,
    );
  });

  it('runWithFailureCapture: durable/customer diagnostics use only closed classes and fixed copy while the original error is rethrown', () => {
    expect(body).toMatch(
      /const failureClass = classifySessionFailure\(err\);\s*const failureCopy = sessionFailureCopy\(failureClass\);/,
    );
    expect(body).toMatch(
      /const errorEvent = projectSessionEventMetadata\(\{\s*type: 'errored',\s*payload: \{ operation, failure_class: failureClass \},\s*durationMs: null,\s*\}\);/,
    );
    expect(body).not.toMatch(/redactText|safeSessionFailureDiagnostic|error_message: errorMessage/);
    expect(body).toMatch(/throw err;/);
  });

  it('runWithFailureCapture: exact busy failure election precedes winner-only teardown/event and rethrow', () => {
    expect(body).toMatch(
      /const failed = await this\.deps\.repo\.failSessionOperation\(\{\s*id: session\.id,\s*accountId: session\.accountId,\s*driverSessionId: session\.driverSessionId,\s*erroredAt,\s*\}\);/,
    );
    expect(body).toContain('if (failed === null) throw new SessionDestroyedError();');
    expect(body).toMatch(
      /await this\.deps\.repo\.recordEvent\(\{\s*sessionId: session\.id,\s*\.\.\.errorEvent,\s*\}\);/,
    );
    expect(body).toMatch(/throw err;/);
  });

  it('all nine direct driver operations share ready→busy admission and exact success settlement', () => {
    expect(body).toMatch(
      /export type SessionOperationClaimResult =\s*\| \{ kind: 'claimed'; session: SessionRecord \}\s*\| \{ kind: 'conflict'; status: 'creating' \| 'busy' \}\s*\| \{ kind: 'terminal'; session: SessionRecord \}\s*\| \{ kind: 'not_found' \};/,
    );
    for (const operation of [
      'navigate',
      'interact',
      'gui_input',
      'wait',
      'state_capture',
      'capture',
      'extract',
      'search',
      'login',
    ]) {
      expect(body).toContain(`'${operation}',`);
    }
    expect(body).toMatch(
      /const settled = await this\.deps\.repo\.settleSessionOperation\(\{\s*id: session\.id,\s*accountId: session\.accountId,\s*driverSessionId: session\.driverSessionId,\s*\}\);/,
    );
    expect(body).toContain('if (!settled) throw new SessionDestroyedError();');
    expect(body).toMatch(
      /if \(claim\.kind === 'conflict'\) \{\s*throw new ConflictError\([\s\S]+?session_status: claim\.status/,
    );
  });

  it('login returns the driver discriminated result without dropping submission truth', () => {
    expect(body).toMatch(
      /import \{\s*DriverLoginResultSchema,\s*DriverSearchResultSchema,\s*type Driver,\s*type LoginResult,\s*type SearchResult,?\s*\} from '\.\.\/drivers\/types\.js';/,
    );
    expect(body).toMatch(
      /async login\(\s*ctx: AccountContext,\s*sessionId: string,\s*body: SessionLoginRequest,\s*opts: \{ effectiveAccountId\?: string \} = \{\},\s*\): Promise<LoginResult> \{/,
    );
    expect(body).toContain('this.deps.driver.login(claimed.driverSessionId, {');
    expect(body).toMatch(
      /if \(this\.deps\.driver\.loginCapability !== 'real'\) \{\s*throw new DriverNotIntegratedError\(\);\s*\}\s*const \{ result \} = await this\.runWithFailureCapture/,
    );
    expect(body).toMatch(
      /const rawResult = await this\.deps\.driver\.login\([\s\S]+?const parsed = DriverLoginResultSchema\.safeParse\(rawResult\);\s*if \(!parsed\.success\) \{[\s\S]+?throw new DriverError\('The browser driver returned an invalid login result\.'\);\s*\}\s*return parsed\.data;/,
    );
  });

  it('search fails closed on non-real capability and strictly parses the driver terminal', () => {
    expect(body).toMatch(
      /async search\(\s*ctx: AccountContext,\s*sessionId: string,\s*body: SearchRequest,\s*opts: \{ effectiveAccountId\?: string \} = \{\},\s*\): Promise<SearchResult> \{/,
    );
    expect(body).toMatch(
      /if \(this\.deps\.driver\.searchCapability !== 'real'\) \{\s*throw new DriverNotIntegratedError\(\);\s*\}\s*const \{ result \} = await this\.runWithFailureCapture/,
    );
    expect(body).toMatch(
      /const rawResult = await this\.deps\.driver\.search\([\s\S]+?const parsed = DriverSearchResultSchema\.safeParse\(rawResult\);\s*if \(!parsed\.success\) \{\s*throw new DriverError\('The browser driver returned an invalid search result\.'\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(\s*!parsed\.data\.queryTruncated &&\s*\(parsed\.data\.submitted !== body\.submit \|\|\s*\(parsed\.data\.resultsVisible !== undefined\) !==\s*\(body\.wait_for_results_selector !== undefined\)\)\s*\) \{\s*throw new DriverError\('The browser driver returned an invalid search result\.'\);\s*\}/,
    );
  });

  it('getState uses a status-neutral monotonic timestamp touch after owner settlement', () => {
    expect(body).toMatch(
      /this\.deps\.repo\.touchSessionLastStateAt\(\{\s*id: session\.id,\s*accountId: session\.accountId,\s*driverSessionId: session\.driverSessionId,\s*lastStateAt: capturedAt,/,
    );
    expect(body).not.toMatch(
      /updateSessionStatus\(session\.id, session\.status, \{\s*lastStateAt: capturedAt/,
    );
  });

  it('successful event payloads are projected synchronously before detached persistence', () => {
    expect(body).toMatch(
      /const createdEvent = projectSessionEventMetadata\(\{[\s\S]+?this\.persistPostSuccessObservability\(record\.accountId, record\.id, 'create', 'event', \(\) =>[\s\S]+?\.\.\.createdEvent,/,
    );
    expect(body).toMatch(
      /const event = projectSessionEventMetadata\(\{\s*type: 'navigated',[\s\S]+?this\.persistPostSuccessObservability\(session\.accountId, session\.id, 'navigate', 'event'/,
    );
    expect(body).toMatch(
      /error_name: timedOut\s*\? 'PostSuccessPersistenceTimeout'\s*:\s*'PostSuccessPersistenceError'/,
    );
  });

  it('listAll: exact driftstack_internal_admin scope; legacy customer admin is insufficient', () => {
    expect(body).toMatch(
      /Cross-account list for the admin panel \+ ops tooling\. Requires\s*\*\s*the exact driftstack_internal_admin scope\. The legacy customer\s*\*\s*'admin' alias is deliberately insufficient for cross-account reads\./,
    );
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/);
    expect(body).toMatch(/return this\.deps\.repo\.listAllSessions\(opts\);/);
  });

  it("capture: 'screenshot' or 'pdf' kind → 'screenshot_captured' event; else 'state_captured'", () => {
    expect(body).toMatch(
      /type:\s*body\.kind === 'screenshot' \|\| body\.kind === 'pdf'\s*\?\s*'screenshot_captured'\s*:\s*'state_captured',/,
    );
  });

  it('imports: api-types defaults (DEFAULT_BEHAVIORAL_PROFILE + DEFAULT_SESSION_PURPOSE + LOCKED_ARCHETYPE_ID + MAX_SESSION_MINUTES_PER_TIER + PROFILES_PER_TIER + TIER_CONCURRENT_SESSION_LIMITS) + AccountContext + Driver + errors + GUIInputRequest', () => {
    expect(body).toMatch(
      /import \{\s*DEFAULT_BEHAVIORAL_PROFILE,\s*DEFAULT_SESSION_PURPOSE,\s*LOCKED_ARCHETYPE_ID,\s*MAX_SESSION_MINUTES_PER_TIER,\s*PROFILES_PER_TIER,\s*TIER_CONCURRENT_SESSION_LIMITS,/,
    );
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(
      /import \{\s*DriverLoginResultSchema,\s*DriverSearchResultSchema,\s*type Driver,\s*type LoginResult,\s*type SearchResult,?\s*\} from '\.\.\/drivers\/types\.js';/,
    );
    expect(body).toMatch(/import type \{ GUIInputRequest \} from '\.\.\/schemas\/gui-input\.js';/);
    expect(body).toMatch(
      /import \{[\s\S]*?BadRequestError,[\s\S]*?ConcurrencyLimitError,[\s\S]*?ConflictError,[\s\S]*?DriverError,[\s\S]*?DriverNotIntegratedError,[\s\S]*?NotFoundError,[\s\S]*?SessionDestroyedError,[\s\S]*?\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
