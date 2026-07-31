// V-355 — customer-facing web-session list + revoke endpoints.
//
// /v1/account/web-sessions   GET     — list the calling account's active
//                                       browser sessions ("Active sign-ins"
//                                       on /settings).
// /v1/account/web-sessions/:id DELETE — revoke a specific session.
// /v1/account/web-sessions   DELETE   — `?keep=current` revokes every
//                                       session EXCEPT the one the caller
//                                       is currently using.
//
// Distinct from /v1/sessions (driver sessions running browsers in the
// fleet) — these are the customer's own dashboard sign-ins.
//
// IP and user-agent are surfaced as broad bucket strings rather than the
// raw values: /settings already comments "IP omitted from dashboard for
// privacy", and the user-agent string is fingerprintable enough that we
// reduce it to "macOS · Safari" before render.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthFlowsService, WebSessionRow } from '../services/auth-flows.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';

export interface AccountWebSessionsRoutesOptions {
  service: AuthFlowsService;
  /** Best-effort audit emitter for account.web_session_revoked (a
   *  security-relevant sign-in revocation). Omitted → no audit. */
  accountAudit?: AccountAuditService;
}

/**
 * V-355 — coarse user-agent bucketer. Pulls just the OS family + browser
 * family out of the raw UA string so the dashboard can show "macOS ·
 * Safari · current" without surfacing the full version-rich UA, which is
 * fingerprintable and changes on every Safari point-release in a way the
 * customer doesn't care about. Returns "Unknown · Unknown" on miss
 * rather than "" so the row always renders something.
 */
export function bucketUserAgent(ua: string | null): { os: string; browser: string } {
  if (!ua) return { os: 'Unknown', browser: 'Unknown' };
  let os = 'Unknown';
  if (/Mac OS X|macOS/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown';
  // Order matters: Edg / OPR / Chrome / Safari (Safari signature is in
  // every WebKit UA so it has to be checked LAST).
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return { os, browser };
}

/**
 * V-355 — extract the calling web session's id from the AccountContext.
 * The auth path stamps the synthetic ApiKeyRow's id as `wsk_<uuid>` for
 * web sessions; non-web-session callers (a real API key) have a
 * different prefix and return null here. Callers should treat null as
 * "this isn't a web-session-authed request" and refuse the operation.
 */
function currentWebSessionIdFromRequest(request: FastifyRequest): string | null {
  const ctx = request.account;
  if (!ctx) return null;
  const id = ctx.apiKey.id;
  if (typeof id !== 'string' || !id.startsWith('wsk_')) return null;
  return id.slice('wsk_'.length);
}

function publicSession(
  row: WebSessionRow,
  currentId: string | null,
): {
  id: string;
  os: string;
  browser: string;
  last_used_at: string;
  expires_at: string;
  current: boolean;
} {
  const ua = bucketUserAgent(row.userAgent);
  return {
    id: `wsess_${row.id}`,
    os: ua.os,
    browser: ua.browser,
    last_used_at: row.lastUsedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    current: row.id === currentId,
  };
}

/**
 * V-355 — strip a `wsess_` prefix from a public id and validate it
 * looks like a uuid. Throws BadRequestError on shape mismatch.
 */
function uuidFromPublicSessionId(input: string): string {
  if (!input.startsWith('wsess_')) {
    throw new BadRequestError('Invalid session id.');
  }
  const id = input.slice('wsess_'.length);
  // Strict UUID shape: the old `[0-9a-fA-F-]{36}` accepted 36 hex-or-dash
  // characters in any arrangement and passed them to a Postgres `uuid`
  // column, so a malformed id 500'd rather than 400'd.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new BadRequestError('Invalid session id.');
  }
  return id;
}

export function registerAccountWebSessionsRoutes(
  app: FastifyInstance,
  opts: AccountWebSessionsRoutesOptions,
): void {
  const { service } = opts;
  const accountAudit = opts.accountAudit ?? null;

  // Best-effort audit of a sign-in revocation (single device or bulk). Carries
  // only the scope + count — no IP/UA of the revoked session. Swallows failures
  // so an audit hiccup never blocks the security operation the customer asked for.
  async function emitRevoked(
    request: FastifyRequest,
    accountId: string,
    targetResourceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!accountAudit) return;
    try {
      await accountAudit.record({
        accountId,
        actorType: 'customer',
        action: 'account.web_session_revoked',
        targetResourceId,
        payload,
        ipAddress: readClientIp(request),
      });
    } catch {
      // Swallow — audit failures must not break session revocation.
    }
  }

  app.get(
    '/v1/account/web-sessions',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const currentId = currentWebSessionIdFromRequest(request);
      const rows = await service.listActiveWebSessions(ctx.account.id);
      return { data: rows.map((r) => publicSession(r, currentId)) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/account/web-sessions/:id',
    // W492 — account_owner: revoking sign-ins is account-security control
    // (consistent with api-keys/account-audit). The dashboard's web-session
    // key carries account_owner; a customer read/write API key cannot revoke
    // dashboard sign-ins.
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const sessionId = uuidFromPublicSessionId(request.params.id);
      const ok = await service.revokeWebSessionForAccount(ctx.account.id, sessionId);
      if (!ok) throw new NotFoundError('Session not found.');
      await emitRevoked(request, ctx.account.id, `wsess_${sessionId}`, { scope: 'single' });
      reply.code(204);
      return null;
    },
  );

  app.delete<{ Querystring: { keep?: string } }>(
    '/v1/account/web-sessions',
    // W492 — account_owner: "sign out everywhere" is account-security control.
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const keep = (request.query?.keep ?? '').toLowerCase();
      if (keep !== 'current') {
        throw new BadRequestError(
          'Bulk revoke requires `?keep=current`. Pass it explicitly to confirm intent.',
        );
      }
      const currentId = currentWebSessionIdFromRequest(request);
      if (currentId === null) {
        // Non-web-session caller can't bulk revoke + keep current —
        // there is no "current" to keep. Refuse rather than guess.
        throw new BadRequestError('Bulk revoke is only callable from a dashboard web session.');
      }
      const n = await service.revokeAllWebSessionsExceptCurrent(ctx.account.id, currentId);
      if (n > 0) {
        await emitRevoked(request, ctx.account.id, `account_${ctx.account.id}`, {
          scope: 'all_except_current',
          revoked: n,
        });
      }
      reply.code(200);
      return { revoked: n };
    },
  );
}
