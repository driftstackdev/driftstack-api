// V-237 — customer self-profile endpoint.
// GET /v1/account/me — returns the calling account's identity + tier
// + concurrent-session usage/cap + profile usage/cap. Powers the GUI
// client's tier-aware enforcement display (file 128 spec mirror) so
// the customer sees "X / Y concurrent sessions" + "P / Q profiles"
// before the API enforces the cap with a 402.
//
// Distinct from `/v1/account/rate-limits` (per-bucket limit config)
// and `/v1/account/audit-log` (event ledger) — this is the dashboard
// header view.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AccountOrganizationSchema,
  AccountProxyInputSchema,
  AccountProxyUpdateSchema,
  AVATAR_MAX_BYTES,
  PROFILES_PER_TIER,
  PROXIES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  UpdateAccountMeRequestSchema,
  UploadAvatarRequestSchema,
  UuidSchema,
  type AccountProxyMetadata,
  type AccountTier,
} from '@driftstack/api-types';
import { resolveEffectiveAccount, type AccountAuthRepo } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { SessionRepo } from '../services/sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';
import type { MfaService } from '../services/mfa.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { readClientIp } from '../lib/client-ip.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import type {
  AccountProxiesRepo,
  AccountProxyRow,
  AccountProxyRowUpdates,
} from '../db/account-proxies-repo.js';
import {
  encryptAccountProxySecret,
  type AccountProxySecretSlot,
} from '../lib/account-proxy-secret-encryption.js';
import { classifyUnsafeHost, classifyUnsafeVpnTargets } from '../lib/webhook-target-guard.js';
import { defaultTcpProbe } from '../services/proxy-backends/socks5.js';
import { avatarKey, type R2 } from '../lib/r2.js';
import {
  BadRequestError,
  ConflictError,
  FeatureUnavailableError,
  ForbiddenError,
  NotFoundError,
} from '../lib/errors.js';

/** V-352b — avatar presigned-GET TTL. 1h is long enough that a single
 *  dashboard render doesn't churn signed URLs but short enough that
 *  rotating the bucket secret invalidates outstanding URLs in <1h. */
const AVATAR_PRESIGN_TTL_SECONDS = 60 * 60;

export interface AccountMeRoutesOptions {
  /** Session count source — same repo SessionsService uses. */
  sessionRepo: SessionRepo;
  /** Profile count source — same repo ProfilesService uses. */
  profilesRepo: ProfilesRepo;
  /** V-352 — needed for PATCH /v1/account/me (name + timezone update). */
  authRepo: AccountAuthRepo;
  /** V-352 — invalidated on PATCH /v1/account/me so the next request
   *  picks up the updated row instead of the stale cached AccountContext. */
  authCache?: AuthCache | null;
  /** V-352b — public-bucket R2 client for avatar upload + presigned GET.
   *  Null when public bucket is not configured (avatar endpoints return 503). */
  r2Public?: R2 | null;
  /** V-353h — MFA service. When wired, GET /v1/account/me surfaces
   *  `mfa_enrolled` so the dashboard can render enrollment status
   *  without a second roundtrip. Null = MFA not wired (flag always
   *  false on the response). */
  mfaService?: MfaService | null;
  /** 2026-05-19 — when set, /v1/account/me falls back to the OAuth
   *  link's `provider_avatar_url` for `avatar_url` whenever the
   *  account has no R2-uploaded avatar set. Lets Gmail/GitHub
   *  sign-ins show their IDP profile picture without going through
   *  an upload flow. Null/omitted → no fallback (legacy behaviour). */
  oauthLinksRepo?: {
    listForAccount(accountId: string): Promise<readonly { providerAvatarUrl: string | null }[]>;
  };
  /** ARC A — per-account customer proxies repo. When wired, the
   *  /v1/account/me/proxies CRUD surface is live. Null/omitted → the routes
   *  return 503 (feature not configured). */
  accountProxiesRepo?: AccountProxiesRepo | null;
  /** ARC A — PROFILE_MASTER_KEY (decoded). Needed to wrap proxy passwords under
   *  the account TMK. Null → passwords can't be stored; a create/update that
   *  carries a password is rejected (503) rather than stored in the clear. */
  profileMasterKey?: Buffer | null;
  /** ARC A slice 4b — injectable TCP-reachability probe for the proxy test
   *  endpoint (resolves on connect, rejects on timeout/refused). Defaults to the
   *  SOCKS5 backend's defaultTcpProbe; tests inject a deterministic stub. */
  proxyTcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** Best-effort audit emitter for proxy.created / proxy.deleted (egress-config
   *  changes are security-relevant + already have dashboard labels/filters).
   *  Omitted → no audit (the customer op still succeeds). */
  accountAudit?: AccountAuditService;
}

/**
 * Resolve the profile cap for a tier. `PROFILES_PER_TIER` returns
 * `'custom'` for enterprise (negotiated per-customer); we surface
 * that as `null` to the customer (read: "no fixed cap on this tier;
 * see your contract"). All other tiers return a numeric cap.
 */
function profileCapFor(tier: AccountTier): number | null {
  const cap = PROFILES_PER_TIER[tier];
  return cap === 'custom' ? null : cap;
}

export function registerAccountMeRoutes(app: FastifyInstance, opts: AccountMeRoutesOptions): void {
  const { sessionRepo, profilesRepo, authRepo } = opts;
  const authCache = opts.authCache ?? null;
  const r2Public = opts.r2Public ?? null;
  const mfaService = opts.mfaService ?? null;
  const oauthLinksRepo = opts.oauthLinksRepo ?? null;
  const accountProxiesRepo = opts.accountProxiesRepo ?? null;
  const proxyMasterKey = opts.profileMasterKey ?? null;
  const proxyTcpProbe = opts.proxyTcpProbe ?? defaultTcpProbe;
  const accountAudit = opts.accountAudit ?? null;

  // Best-effort audit emit for proxy lifecycle (egress-config changes). Carries
  // only non-secret metadata (id / label / scheme) — NEVER the credential.
  // Swallows failures so an audit hiccup never breaks the customer operation.
  async function emitProxyAudit(
    request: FastifyRequest,
    accountId: string,
    action: 'proxy.created' | 'proxy.updated' | 'proxy.deleted',
    proxy: { id: string; label: string; scheme: string },
  ): Promise<void> {
    if (!accountAudit) return;
    try {
      await accountAudit.record({
        accountId,
        actorType: 'customer',
        action,
        targetResourceId: `proxy_${proxy.id}`,
        payload: { proxy_id: proxy.id, label: proxy.label, scheme: proxy.scheme },
        ipAddress: readClientIp(request),
      });
    } catch {
      // Swallow — audit emit failures must not break the proxy operation.
    }
  }

  // 2026-05-19 — first non-null providerAvatarUrl from the
  // account's OAuth links, used as fallback when avatar_r2_key is
  // null. Swallows errors (best-effort enrichment; a stale /me
  // read should never 500 because oauth_links hiccuped).
  async function oauthAvatarFallback(accountId: string): Promise<string | null> {
    if (!oauthLinksRepo) return null;
    try {
      const links = await oauthLinksRepo.listForAccount(accountId);
      for (const link of links) {
        if (link.providerAvatarUrl) return link.providerAvatarUrl;
      }
      return null;
    } catch (err) {
      app.log.warn({ err, accountId }, 'oauth avatar fallback lookup failed');
      return null;
    }
  }

  // V-352b — best-effort presigned GET URL for the avatar. Returns null
  // when no avatar is set, when the public R2 bucket is not configured,
  // or when the presign call itself fails (logged + swallowed: a stale
  // /me read should never 500 just because R2 hiccuped).
  async function presignAvatar(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (!r2Public) return null;
    try {
      return await r2Public.presignGet({
        key,
        expiresIn: AVATAR_PRESIGN_TTL_SECONDS,
      });
    } catch (err) {
      app.log.warn({ err, key }, 'avatar presign failed');
      return null;
    }
  }

  app.get(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const accountId = ctx.account.id;
      const tier = ctx.account.tier;

      // Parallel fan-out: counts + tier-derived caps + avatar presign + MFA.
      // Tier caps come from in-memory constants so they cost nothing.
      const [activeSessions, profileCount, r2AvatarUrl, mfaStatus, oauthFallback] =
        await Promise.all([
          sessionRepo.countActiveSessions(accountId),
          profilesRepo.countByAccount(accountId),
          presignAvatar(ctx.account.avatarR2Key),
          mfaService ? mfaService.getStatus(accountId) : Promise.resolve(null),
          ctx.account.avatarR2Key ? Promise.resolve(null) : oauthAvatarFallback(accountId),
        ]);
      // R2-uploaded avatar wins; OAuth IDP avatar is the fallback
      // (matches account_avatar_source enum priority: user > idp).
      const avatarUrl = r2AvatarUrl ?? oauthFallback;
      const avatarSource = ctx.account.avatarR2Key ? 'user' : oauthFallback ? 'idp' : 'none';

      return {
        id: `acc_${accountId}`,
        email: ctx.account.email,
        name: ctx.account.name,
        tier,
        status: ctx.account.status,
        // V-352 — IANA timezone (null = UTC fallback for client renders).
        timezone: ctx.account.timezone,
        // V-298a — readable account handle (null when unset).
        slug: ctx.account.slug,
        // V-298b — data-residency region preference (null when unset).
        region: ctx.account.region,
        // V-352b — selected avatar URL: a short-lived (1h) presigned R2
        // customer upload, otherwise the linked-IDP fallback. Null only
        // when neither source is available.
        avatar_url: avatarUrl,
        // A URL alone cannot tell a removable customer upload from the
        // read-only OAuth fallback. Keep that distinction public so clients
        // never offer a destructive control that cannot affect the image.
        avatar_source: avatarSource,
        // V-353h — MFA enrollment flag for dashboard header / settings.
        mfa_enrolled: mfaStatus !== null && mfaStatus.enrolled,
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
        // V-326c — owner accounts the caller is a member of (empty
        // array when not on any team). Each entry exposes the public
        // owner id + the owner's email/name (so the dashboard can label
        // a team by who owns it, not a bare acc_<uuid>) + the role granted
        // to the caller. Used by the dashboard / GUI to render an
        // "acting as" account picker.
        teams: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          owner_email: t.ownerEmail ?? `acc_${t.ownerAccountId}`,
          owner_name: t.ownerName ?? null,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  // V-352 — partial update of the calling account's basics
  // (name + timezone). Other fields (email / tier / status /
  // stripeCustomerId) have dedicated flows and aren't reachable here.
  // Note: V-326 effective-account header is intentionally NOT honored
  // — /v1/account/me always operates on the caller's own account.
  // Acting on a team owner's account.name / timezone would be
  // surprising; if needed, lands in V-352c with explicit semantics.
  app.patch(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = UpdateAccountMeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      let updated;
      try {
        updated = await authRepo.updateAccountBasics(ctx.account.id, parsed.data);
      } catch (err) {
        // V-298a — repo throws SLUG_TAKEN when the unique-constraint
        // collides with another account's slug. 409 surfaces it.
        if (err instanceof Error && err.message === 'SLUG_TAKEN') {
          throw new ConflictError('That slug is already taken. Pick a different one.');
        }
        throw err;
      }
      if (!updated) throw new NotFoundError('Account not found.');
      // Invalidate the cached AccountContext so the next request reads
      // the freshly-updated row. Best-effort; cache failure must never
      // block the user-facing op.
      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }
      // Return the same full-shape response as GET /me — the OpenAPI
      // spec + every SDK type claim AccountMeResponse (16 fields).
      // Previously the route returned only the 8 written/persisted
      // fields, causing a type-vs-runtime mismatch on every SDK
      // consumer (avatar_url / mfa_enrolled / concurrent_session_*
      // / profile_* / teams[] all undefined under types claiming
      // string|null / boolean / number / array).
      const tier = updated.tier;
      const [activeSessions, profileCount, r2AvatarUrl, mfaStatus, oauthFallback] =
        await Promise.all([
          sessionRepo.countActiveSessions(updated.id),
          profilesRepo.countByAccount(updated.id),
          presignAvatar(updated.avatarR2Key),
          mfaService ? mfaService.getStatus(updated.id) : Promise.resolve(null),
          updated.avatarR2Key ? Promise.resolve(null) : oauthAvatarFallback(updated.id),
        ]);
      const avatarUrl = r2AvatarUrl ?? oauthFallback;
      const avatarSource = updated.avatarR2Key ? 'user' : oauthFallback ? 'idp' : 'none';
      return {
        id: `acc_${updated.id}`,
        email: updated.email,
        name: updated.name,
        tier,
        status: updated.status,
        timezone: updated.timezone,
        slug: updated.slug,
        region: updated.region,
        avatar_url: avatarUrl,
        avatar_source: avatarSource,
        mfa_enrolled: mfaStatus !== null && mfaStatus.enrolled,
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
        teams: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          owner_email: t.ownerEmail ?? `acc_${t.ownerAccountId}`,
          owner_name: t.ownerName ?? null,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  // Per-account org-sync (2026-06-16) — the effective account's organization
  // TAXONOMY: the empty folders (+icons) and tags defined in the GUI rail
  // before assignment. Unlike the identity/edit route at exact /v1/account/me,
  // this nested profile resource honors X-Driftstack-Account so its taxonomy
  // and the profiles it organizes always share an owner. Team members may read;
  // team writes require admin. Stored as accounts.organization jsonb (0079).
  // Not part of the cached AccountContext, so no auth-cache invalidation needed.
  app.get(
    '/v1/account/me/organization',
    { preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const org = await authRepo.getOrganization(effective.accountId);
      return org ?? { folders: [], tags: [] };
    },
  );

  app.put(
    '/v1/account/me/organization',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      // Resolve and authorize the selected owner before parsing the body. A
      // malformed payload must never turn a nonmember/member authorization
      // failure into a body-validation oracle, and must never reach the repo.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(
          'Team members need the admin role to change profile organization.',
        );
      }
      const parsed = AccountOrganizationSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid organization.');
      }
      await authRepo.setOrganization(effective.accountId, parsed.data);
      return parsed.data;
    },
  );

  // ARC A — per-account customer proxies (CRUD). The customer registers their
  // own SOCKS5/HTTP proxies so a session can be dispatched through one (the
  // session-dispatch wiring lands in a later slice). All routes are
  // account_owner-scoped; the password is WRITE-ONLY — wrapped under the account
  // TMK on write, NEVER returned (responses expose has_password). 503 when the
  // feature isn't wired. The connection-test endpoint is deliberately deferred
  // to the slice that ships the SSRF host-guard (testing a customer-controlled
  // host is an SSRF vector — don't expose it before the guard exists).
  function proxyToMetadata(r: AccountProxyRow): AccountProxyMetadata {
    return {
      id: r.id,
      label: r.label,
      scheme: r.scheme as AccountProxyMetadata['scheme'],
      host: r.host,
      port: r.port,
      username: r.username,
      has_password: r.wrappedPassword !== null,
      has_secret: r.wrappedSecret !== null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  // SSRF guard — reject a proxy host that resolves to an internal-reachable
  // address (loopback / RFC-1918 / link-local / cloud metadata / numeric-IP
  // encoding) before it's ever stored or dispatched through. Reuses the shared
  // host classifier (same one the webhook + SOCKS5 egress guards use).
  function assertSafeProxyHost(host: string): void {
    const unsafe = classifyUnsafeHost(host);
    if (unsafe !== null) {
      throw new BadRequestError(
        'Proxy host must not target a private, loopback, link-local, or metadata address.',
      );
    }
  }

  // Wrap a plaintext proxy password under the account TMK with exact proxy/slot
  // AAD. Empty/null → null (no secret). A non-empty password with no master key
  // configured
  // is a 503 — we NEVER store a proxy password in the clear.
  function wrapProxyPassword(
    accountId: string,
    proxyId: string,
    password: string | null,
  ): string | null {
    if (password === null || password.length === 0) return null;
    if (proxyMasterKey === null) {
      throw new FeatureUnavailableError(
        'Proxy passwords are unavailable (encryption not configured).',
      );
    }
    return encryptAccountProxySecret(
      proxyMasterKey,
      { accountId, proxyId, slot: 'password' },
      password,
    );
  }

  // Wrap a non-empty VPN secret payload under the account TMK + proxy/slot AAD. Like
  // wrapProxyPassword but mandatory (a VPN proxy always carries a secret) — 503
  // if encryption isn't configured (NEVER store a VPN key in the clear).
  function wrapProxySecret(
    accountId: string,
    proxyId: string,
    slot: Exclude<AccountProxySecretSlot, 'password'>,
    secret: string,
  ): string {
    if (proxyMasterKey === null) {
      throw new FeatureUnavailableError('VPN proxies are unavailable (encryption not configured).');
    }
    return encryptAccountProxySecret(proxyMasterKey, { accountId, proxyId, slot }, secret);
  }

  function parseProxyId(value: string): string {
    const parsed = UuidSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestError('Proxy id must be a valid UUID.');
    return parsed.data.toLowerCase();
  }

  // Resolve the encrypted-secret + non-secret config for a VPN scheme. Returns
  // null for socks5/http (the caller keeps the password path). For openvpn the
  // SECRET is {config_blob[,password]} (the blob embeds certs/keys); for
  // wireguard it's the private_key. The non-secret structured fields ride
  // `config` (jsonb) so the GUI/dispatch can read them without decrypting.
  function buildVpnSecretAndConfig(
    accountId: string,
    proxyId: string,
    input: {
      scheme?: string;
      openvpn?: { config_blob: string; username?: string; password?: string };
      wireguard?: {
        private_key: string;
        peer_public_key: string;
        endpoint: string;
        allowed_ips: string;
        address?: string;
        dns?: string;
      };
    },
  ): { wrappedSecret: string; config: Record<string, unknown> } | null {
    if (input.scheme === 'openvpn') {
      if (!input.openvpn) {
        throw new BadRequestError('An `openvpn` config is required for scheme "openvpn".');
      }
      const { config_blob, username, password } = input.openvpn;
      // SSRF: the real egress is the embedded `remote <host>`, NOT the display host — guard it.
      if (classifyUnsafeVpnTargets({ configBlob: config_blob }) !== null) {
        throw new BadRequestError(
          'OpenVPN config must not target a private, loopback, link-local, or metadata ' +
            'address, or use a script-executing directive (up/down/route-up/tls-verify/… ' +
            'or script-security 2+).',
        );
      }
      const secret = JSON.stringify({ config_blob, ...(password ? { password } : {}) });
      return {
        wrappedSecret: wrapProxySecret(accountId, proxyId, 'openvpn-config', secret),
        config: { ...(username ? { username } : {}) },
      };
    }
    if (input.scheme === 'wireguard') {
      if (!input.wireguard) {
        throw new BadRequestError('A `wireguard` config is required for scheme "wireguard".');
      }
      const { private_key, peer_public_key, endpoint, allowed_ips, address, dns } = input.wireguard;
      // SSRF: the real egress is the endpoint (+ dns), NOT the display host — guard them.
      if (classifyUnsafeVpnTargets({ endpoint, dns }) !== null) {
        throw new BadRequestError(
          'WireGuard endpoint/DNS must not target a private, loopback, link-local, or metadata address.',
        );
      }
      return {
        wrappedSecret: wrapProxySecret(accountId, proxyId, 'wireguard-private-key', private_key),
        config: {
          peer_public_key,
          endpoint,
          allowed_ips,
          ...(address ? { address } : {}),
          ...(dns ? { dns } : {}),
        },
      };
    }
    // socks5/http: a stray VPN block is a client error (avoids a half-typed row).
    if (input.openvpn || input.wireguard) {
      throw new BadRequestError(
        '`openvpn`/`wireguard` config is only valid for the matching scheme.',
      );
    }
    return null;
  }

  app.get(
    '/v1/account/me/proxies',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const rows = await accountProxiesRepo.list(ctx.account.id);
      return { data: rows.map(proxyToMetadata) };
    },
  );

  app.post(
    '/v1/account/me/proxies',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      // AccountProxyInputSchema is a discriminatedUnion on `scheme` with no
      // default (mirrors egress.ts's ProxyConfigSchema) — an omitted `scheme`
      // no longer matches any branch. Fill the pre-V1 ergonomic default
      // (omitted scheme => socks5) into the RAW body here so the wire
      // contract for existing callers is unchanged.
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      const bodyWithScheme = 'scheme' in rawBody ? rawBody : { ...rawBody, scheme: 'socks5' };
      const parsed = AccountProxyInputSchema.safeParse(bodyWithScheme);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid proxy.');
      }
      assertSafeProxyHost(parsed.data.host);
      const id = randomUUID();
      // VPN schemes carry an encrypted secret (config_blob / private_key) + a
      // non-secret config block; socks5/http use the write-only password.
      const vpn = buildVpnSecretAndConfig(ctx.account.id, id, parsed.data);
      const wrappedPassword =
        vpn === null ? wrapProxyPassword(ctx.account.id, id, parsed.data.password) : null;
      const input = {
        id,
        label: parsed.data.label,
        scheme: parsed.data.scheme,
        host: parsed.data.host,
        port: parsed.data.port,
        username: parsed.data.username,
        wrappedPassword,
        ...(vpn !== null ? { wrappedSecret: vpn.wrappedSecret, config: vpn.config } : {}),
      };
      const proxyCap = PROXIES_PER_TIER[ctx.account.tier];
      const row =
        proxyCap === 'custom'
          ? await accountProxiesRepo.create(ctx.account.id, input)
          : await accountProxiesRepo.createIfUnderLimit(ctx.account.id, input, proxyCap);
      if (row === null) {
        throw new BadRequestError(
          `Proxy limit reached (${String(proxyCap)}). Delete an existing proxy to add another.`,
        );
      }
      await emitProxyAudit(request, ctx.account.id, 'proxy.created', row);
      reply.code(201);
      return proxyToMetadata(row);
    },
  );

  app.put(
    '/v1/account/me/proxies/:id',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const id = parseProxyId((request.params as { id: string }).id);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = AccountProxyUpdateSchema.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid proxy.');
      }
      const existing = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
      if (existing === null) throw new NotFoundError('Proxy not found.');
      if (
        parsed.data.scheme === undefined &&
        (existing.scheme === 'openvpn' || existing.scheme === 'wireguard') &&
        'password' in body
      ) {
        throw new BadRequestError(
          'A VPN password can only be changed by resubmitting the matching VPN configuration.',
        );
      }
      if (parsed.data.host !== undefined) assertSafeProxyHost(parsed.data.host);
      const updates: AccountProxyRowUpdates = {};
      if (parsed.data.label !== undefined) updates.label = parsed.data.label;
      if (parsed.data.scheme !== undefined) updates.scheme = parsed.data.scheme;
      if (parsed.data.host !== undefined) updates.host = parsed.data.host;
      if (parsed.data.port !== undefined) updates.port = parsed.data.port;
      if (parsed.data.username !== undefined) updates.username = parsed.data.username;
      // VPN re-config: a VPN block (with its matching scheme) re-wraps the secret
      // + rewrites config + clears any password. Otherwise the socks5/http
      // password path: key absent = keep existing; null = clear; string = (re)wrap.
      const vpn = buildVpnSecretAndConfig(ctx.account.id, id, parsed.data);
      if (vpn !== null) {
        updates.wrappedSecret = vpn.wrappedSecret;
        updates.config = vpn.config;
        updates.wrappedPassword = null;
      } else {
        if ('password' in body) {
          updates.wrappedPassword = wrapProxyPassword(
            ctx.account.id,
            id,
            parsed.data.password ?? null,
          );
        }
        // Moving AWAY from a VPN scheme (openvpn/wireguard -> socks5/http) must
        // clear the stale wrapped VPN secret + config — otherwise the old
        // private_key/config_blob ciphertext (and a misleading has_secret=true)
        // survive indefinitely under the new non-VPN row.
        if (
          parsed.data.scheme !== undefined &&
          parsed.data.scheme !== 'openvpn' &&
          parsed.data.scheme !== 'wireguard'
        ) {
          updates.wrappedSecret = null;
          updates.config = {};
        }
      }
      const row = await accountProxiesRepo.update({
        id,
        accountId: ctx.account.id,
        expectedScheme: existing.scheme,
        updates,
      });
      if (row === null) {
        const current = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
        if (current === null) throw new NotFoundError('Proxy not found.');
        throw new ConflictError('Proxy changed concurrently. Retry the update.');
      }
      await emitProxyAudit(request, ctx.account.id, 'proxy.updated', row);
      return proxyToMetadata(row);
    },
  );

  app.delete(
    '/v1/account/me/proxies/:id',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const id = parseProxyId((request.params as { id: string }).id);
      // Read the row first so the audit entry carries its label/scheme (delete
      // returns only a boolean). Best-effort — a missing read still deletes.
      const existing = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
      const ok = await accountProxiesRepo.delete({ id, accountId: ctx.account.id });
      if (!ok) throw new NotFoundError('Proxy not found.');
      if (existing !== null) {
        await emitProxyAudit(request, ctx.account.id, 'proxy.deleted', existing);
      }
      reply.code(204);
      return null;
    },
  );

  // ARC A slice 4b — server-side connection test. TCP-reachability probe to the
  // owned proxy's host:port (SSRF host-guard runs first, fail-closed). Returns a
  // discriminated result (ok=true+latency_ms | ok=false+reason), 200 either way —
  // an unreachable proxy is a result, not an error. 404 for an unknown/foreign id.
  app.post(
    '/v1/account/me/proxies/:id/test',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!accountProxiesRepo) throw new FeatureUnavailableError('Proxies are not configured.');
      const id = parseProxyId((request.params as { id: string }).id);
      const row = await accountProxiesRepo.findById({ id, accountId: ctx.account.id });
      if (row === null) throw new NotFoundError('Proxy not found.');
      if (classifyUnsafeHost(row.host) !== null) {
        return {
          ok: false as const,
          reason: 'Proxy host is not allowed (private/reserved address).',
        };
      }
      const startedAt = Date.now();
      try {
        await proxyTcpProbe(row.host, row.port, 8_000);
        return { ok: true as const, latency_ms: Date.now() - startedAt };
      } catch {
        // The probe can surface Node socket/TLS details (and a remote endpoint
        // can influence some protocol text). Keep the public discriminated
        // result stable; raw transport diagnostics never belong in an API body.
        return {
          ok: false as const,
          reason: 'Proxy unreachable. Check the host, port, and firewall.',
        };
      }
    },
  );

  // V-352b — upload (or replace) the calling account's avatar. Inline
  // base64 body, validated for MIME + size, written to R2 public
  // bucket, then the DB pointer + auth-cache flush. The client gets a
  // presigned GET URL (same shape as /v1/account/me) so it never has
  // to handle bucket URLs directly.
  //
  // bodyLimit override: Fastify defaults to 1 MiB JSON. A 2 MiB raw
  // image becomes ~2.8 MiB base64; we cap the route at 3.5 MiB so a
  // legitimate 2 MiB upload + JSON envelope fits and anything beyond
  // is short-circuited as 413 by Fastify before our handler runs.
  app.post(
    '/v1/account/me/avatar',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
      bodyLimit: 3.5 * 1024 * 1024,
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!r2Public) {
        throw new FeatureUnavailableError('Avatar uploads are not available on this deployment.');
      }
      const parsed = UploadAvatarRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(parsed.data.data_base64, 'base64');
      } catch {
        throw new BadRequestError('data_base64 is not valid base64.');
      }
      if (bytes.length === 0) {
        throw new BadRequestError('Avatar image is empty.');
      }
      if (bytes.length > AVATAR_MAX_BYTES) {
        throw new BadRequestError(`Avatar image is too large. Max ${AVATAR_MAX_BYTES} bytes.`);
      }

      const key = avatarKey(ctx.account.id, parsed.data.content_type);
      try {
        await r2Public.putObject({
          key,
          body: bytes,
          contentType: parsed.data.content_type,
        });
      } catch (err) {
        app.log.error({ err, key }, 'avatar upload to R2 failed');
        throw new FeatureUnavailableError('Avatar storage is temporarily unavailable.');
      }

      const updated = await authRepo.updateAccountBasics(ctx.account.id, {
        avatarR2Key: key,
      });
      if (!updated) throw new NotFoundError('Account not found.');

      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }

      const url = await presignAvatar(updated.avatarR2Key);
      reply.code(200);
      return {
        avatar_url: url,
        content_type: parsed.data.content_type,
        bytes: bytes.length,
      };
    },
  );

  // V-352b — clear the avatar pointer on the account row. The R2
  // object is intentionally left in place: a future sweeper job
  // collects orphaned avatar keys (off the hot path; avatars are
  // already public-readable so leaving stale objects is no worse
  // than the public bucket already is). Returns 204.
  app.delete(
    '/v1/account/me/avatar',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const updated = await authRepo.updateAccountBasics(ctx.account.id, {
        avatarR2Key: null,
      });
      if (!updated) throw new NotFoundError('Account not found.');

      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }

      reply.code(204);
      return null;
    },
  );
}
