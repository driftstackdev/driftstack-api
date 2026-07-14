// Auth middleware: validates the Authorization header, attaches the
// account context to `request.account`, and rejects with the appropriate
// problem+json error if the key is missing/invalid/revoked/expired.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountAuthRepo, AccountContext } from '../services/auth.js';
import { authenticate, extractBearerToken, requireScope } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { AuthCoalescer } from '../services/auth-coalescer.js';
import type { NegativeAuthCache } from '../services/negative-auth-cache.js';
import type { OAuthStore } from '../services/oauth.js';
import type { MfaService } from '../services/mfa.js';
import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  MfaStepUpRequiredError,
  RevokedKeyError,
  UnauthorizedError,
} from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import type { ApiKeyScope } from '@driftstack/api-types';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountContext | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * SSE/EventSource auth. Identical to {@link requireAuth} except it
     * ALSO accepts the bearer token from a `?ds_token=` query param —
     * the browser `EventSource` API can't set an `Authorization`
     * header. The header still wins when present. Opt-in per-route:
     * wire it ONLY on `text/event-stream` routes (query-string
     * credentials can surface in access logs). Implements the
     * documented transcript-stream contract (apps/docs api/agent-sessions).
     */
    requireAuthEventSource: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireScope: (
      scope: ApiKeyScope,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * V-353e — step-up MFA gate. Throws MfaStepUpRequiredError (403)
     * when the calling web session's `mfa_satisfied_at` is null or
     * older than the freshness window (default 15 min per V-353a Q4).
     * No-ops when the calling account is NOT MFA-enrolled (gate
     * empty), or when the caller is API-key-authed (machine path,
     * MFA is a human-factor concept). Configure the window per-route
     * if you want shorter (e.g. 5 min for billing-tier change).
     */
    requireMfaFresh: (opts?: {
      freshnessSeconds?: number;
    }) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * 2026-06-04 — project-OWNER gate. Lazy-auths (runs requireAuth if
     * not yet authed), then admits ONLY the configured owner account
     * ({@link AuthPluginOptions.ownerEmail}); throws ForbiddenError (403)
     * for everyone else, including staff-admins. Fails CLOSED when no
     * owner is configured. Wire on the high-power owner-only routes
     * (pricing, secrets, project config).
     */
    requireOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  authRepo: AccountAuthRepo;
  authCache: AuthCache | null;
  authCoalescer: AuthCoalescer | null;
  /**
   * DoS hardening — short-TTL negative cache so a flood of the SAME
   * bogus bearer token skips the prefix-lookup + scrypt verify after the
   * first rejection. null → disabled (auth works, just unamortised on
   * negatives).
   */
  negativeAuthCache?: NegativeAuthCache | null;
  /** Third-party OAuth bearer authority; absent fixtures reject `oat_` tokens. */
  oauthStore?: OAuthStore | null;
  /** V-353e — when set, step-up gate consults this for enrollment
   *  state. When omitted the gate becomes a no-op (MFA off in this
   *  deploy / test fixture without it). */
  mfaService?: MfaService | null;
  /** Arc 7 obs.6 — optional metrics registry. When wired, the plugin
   *  increments `driftstack_auth_total{outcome}` per requireAuth call.
   *  Outcome is one of: ok | unauthorized | invalid | revoked |
   *  expired | forbidden | error. Bounded label cardinality. */
  metrics?: MetricsRegistry;
  /**
   * 2026-05-19 — lowercased email allowlist for the staff bump on
   * the web-session auth path. Accounts in this set get
   * `driftstack_internal_admin` appended to the synthetic api-key
   * scope set so the dashboard user can hit /v1/admin/*. Empty set
   * (default) → no bump.
   */
  staffEmails?: ReadonlySet<string>;
  /**
   * 2026-06-04 — lowercased email of the project OWNER (master) account.
   * The `requireOwner` gate admits ONLY this account (high-power admin
   * surfaces: pricing, secrets, project config). Undefined/empty → the
   * gate fails closed (forbids everyone). The owner is separately unioned
   * into {@link staffEmails} at bootstrap so they are always admin too.
   */
  ownerEmail?: string | null;
}

/** Map a thrown auth error to a bounded outcome label. */
function classifyAuthError(err: unknown): string {
  if (err instanceof UnauthorizedError) return 'unauthorized';
  if (err instanceof InvalidKeyError) return 'invalid';
  if (err instanceof RevokedKeyError) return 'revoked';
  if (err instanceof ExpiredKeyError) return 'expired';
  if (err instanceof ForbiddenError) return 'forbidden';
  return 'error';
}

/** V-353e — default step-up freshness window per V-353a Q4 verdict. */
export const DEFAULT_MFA_FRESHNESS_SECONDS = 15 * 60;

function authPlugin(
  app: FastifyInstance,
  opts: AuthPluginOptions,
  done: (err?: Error) => void,
): void {
  app.decorateRequest('account', null);

  const requireAuth = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const token = extractBearerToken(request.headers.authorization);
      const ctx = await authenticate(
        opts.authRepo,
        token,
        opts.authCache,
        new Date(),
        opts.authCoalescer,
        opts.staffEmails ?? new Set(),
        opts.negativeAuthCache ?? null,
        opts.oauthStore ?? null,
      );
      request.account = ctx;
      try {
        opts.metrics?.inc(METRIC_NAMES.authTotal, { outcome: 'ok' });
      } catch {
        // Swallow; metrics are best-effort.
      }
    } catch (err) {
      try {
        opts.metrics?.inc(METRIC_NAMES.authTotal, { outcome: classifyAuthError(err) });
      } catch {
        // Swallow; metrics are best-effort.
      }
      throw err;
    }
  };

  app.decorate('requireAuth', requireAuth);

  // SSE/EventSource auth — accepts the bearer token from `?ds_token=`
  // when no Authorization header is present (EventSource can't set
  // headers). Standalone (NOT a wrapper around requireAuth) so the
  // proven header-only path stays byte-for-byte unchanged. The header
  // wins when both are supplied. See the FastifyInstance decl above.
  const requireAuthEventSource = async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    try {
      let token: string;
      if (request.headers.authorization) {
        token = extractBearerToken(request.headers.authorization);
      } else {
        const query = request.query as { ds_token?: unknown } | undefined;
        const dsToken =
          query !== undefined && typeof query.ds_token === 'string' ? query.ds_token : undefined;
        if (dsToken === undefined || dsToken.length === 0) {
          throw new UnauthorizedError('Missing Authorization header or ds_token query param.');
        }
        token = dsToken;
      }
      const ctx = await authenticate(
        opts.authRepo,
        token,
        opts.authCache,
        new Date(),
        opts.authCoalescer,
        opts.staffEmails ?? new Set(),
        opts.negativeAuthCache ?? null,
        opts.oauthStore ?? null,
      );
      request.account = ctx;
      try {
        opts.metrics?.inc(METRIC_NAMES.authTotal, { outcome: 'ok' });
      } catch {
        // Swallow; metrics are best-effort.
      }
    } catch (err) {
      try {
        opts.metrics?.inc(METRIC_NAMES.authTotal, { outcome: classifyAuthError(err) });
      } catch {
        // Swallow; metrics are best-effort.
      }
      throw err;
    }
  };

  app.decorate('requireAuthEventSource', requireAuthEventSource);

  app.decorate('requireScope', (scope: ApiKeyScope) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.account) {
        await requireAuth(request, reply);
      }
      if (request.account) requireScope(request.account, scope);
    };
  });

  // V-353e — step-up MFA gate.
  app.decorate('requireMfaFresh', (gateOpts?: { freshnessSeconds?: number }) => {
    const window = gateOpts?.freshnessSeconds ?? DEFAULT_MFA_FRESHNESS_SECONDS;
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.account) {
        await requireAuth(request, reply);
      }
      const ctx = request.account;
      if (!ctx) return; // requireAuth would have thrown
      // API-key callers (no web session) bypass — MFA is a human-
      // factor gate, not a machine-to-machine concept. Founder may
      // revisit if api-key auth needs MFA gating; surface as a
      // separate slice if so.
      if (ctx.webSession === null) return;
      // No MfaService wired = MFA disabled in this deploy → no gate.
      if (!opts.mfaService) return;
      const status = await opts.mfaService.getStatus(ctx.account.id);
      if (!status.enrolled) return;
      const sat = ctx.webSession.mfaSatisfiedAt;
      if (sat === null) {
        throw new MfaStepUpRequiredError('never_satisfied');
      }
      const ageSec = (Date.now() - sat.getTime()) / 1000;
      if (ageSec > window) {
        throw new MfaStepUpRequiredError('expired');
      }
    };
  });

  // 2026-06-04 — project-OWNER gate. Admits ONLY the configured owner
  // account; fails CLOSED when no owner is configured. Lazy-auths like
  // requireScope so a route can use `[app.requireOwner]` alone.
  const ownerEmail = opts.ownerEmail != null ? opts.ownerEmail.trim().toLowerCase() : null;
  app.decorate(
    'requireOwner',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.account) {
        await requireAuth(request, reply);
      }
      const ctx = request.account;
      if (!ctx) return; // requireAuth would have thrown
      if (ownerEmail === null || ownerEmail.length === 0) {
        throw new ForbiddenError('This action requires the project owner account.');
      }
      if (ctx.account.email.toLowerCase() !== ownerEmail) {
        throw new ForbiddenError('This action requires the project owner account.');
      }
    },
  );

  done();
}

export default fp(authPlugin, { name: 'auth' });
