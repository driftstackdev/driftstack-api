// Shared harness for the `an-oauth-*` / `a-top-level-oauth-*` guards
// (cookie-free OAuth v2, 2026-09-11).
//
// Mounts `registerOAuthClientRoutes` on a bare Fastify with the app's
// problem+json error handler, an InMemoryMfaChallengeStore as the v2 flow
// store, a memory rate-limit store, COUNTING stubs for the account service
// and session minting (so a guard can assert "no DB write happened yet"),
// and an injected IDP fetch — the seam `RegisterOAuthClientRoutesDeps.fetch`
// exists for. No Postgres, no Redis, no build-test-app: the route file is
// exercised directly, the way oauth-client-start-accepts-both-first-party-
// dashboard-hosts.test.ts already does.

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { createHash, randomBytes } from 'node:crypto';
import { registerOAuthClientRoutes } from '../../src/routes/auth-oauth-client.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { InMemoryMfaChallengeStore } from '../../src/services/mfa-challenge-store.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import type {
  LinkOrCreateAccountArgs,
  LinkOrCreateAccountResult,
  OAuthClientService,
} from '../../src/services/oauth-client.js';
import type { AuthFlowsService, OAuthWebSessionResult } from '../../src/services/auth-flows.js';
import {
  signOauthClientState,
  verifyOauthClientState,
  type OAuthClientStatePayload,
} from '../../src/lib/oauth-client-state.js';

export const SIGNING_SECRET = 'oauth-v2-guard-signing-secret-0123456789abcdef';
export const CALLBACK_URL_BASE = 'https://api.driftstack.test/v1/auth/oauth';
/** First-party, so the allow-list widens to app.driftstack.io as well. */
export const DEFAULT_DASHBOARD_ORIGIN = 'https://app.driftstack.dev';
export const CREDS = { clientId: 'guard-client-id', clientSecret: 'guard-client-secret' };
export const SESSION_PLAINTEXT = 'ds_web_guard_session_plaintext';
export const IDP_CODE = 'idp-authorization-code-1';

export type Provider = 'google' | 'github';

export interface IdpCall {
  url: string;
  init: RequestInit | undefined;
}

export interface SessionCall {
  accountId: string;
  issuedFromIp: string | null;
  userAgent: string | null;
  provider: string;
}

export interface HarnessOpts {
  dashboardOrigin?: string;
  idp?: 'ok' | 'token-fails' | 'userinfo-fails';
  linkResult?: LinkOrCreateAccountResult;
  /** `null` = account inactive (issueOAuthWebSession returns null). */
  sessionResult?: OAuthWebSessionResult | null;
  nowMs?: () => number;
}

export interface Harness {
  app: FastifyInstance;
  dashboardOrigin: string;
  store: InMemoryMfaChallengeStore;
  /** Keys handed to flowStore.set / .consume, in order. */
  storeSets: string[];
  storeConsumes: string[];
  idpCalls: IdpCall[];
  linkCalls: LinkOrCreateAccountArgs[];
  sessionCalls: SessionCall[];
}

export async function mountOauthHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const app = Fastify();
  registerErrorHandler(app);

  const store = new InMemoryMfaChallengeStore();
  const storeSets: string[] = [];
  const storeConsumes: string[] = [];
  const flowStore = {
    set: (key: string, value: string, ttlSeconds: number): Promise<void> => {
      storeSets.push(key);
      return store.set(key, value, ttlSeconds);
    },
    consume: (key: string): Promise<string | null> => {
      storeConsumes.push(key);
      return store.consume(key);
    },
  };

  const idp = opts.idp ?? 'ok';
  const idpCalls: IdpCall[] = [];
  const json = (status: number, body: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    idpCalls.push({ url, init });
    if (/\/token$|\/access_token$/.test(url)) {
      if (idp === 'token-fails') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'idp-access-token', token_type: 'bearer' });
    }
    if (idp === 'userinfo-fails') return json(401, {});
    if (url.startsWith('https://api.github.com/user')) {
      return json(200, {
        id: 4242,
        login: 'octo',
        name: 'Octo Cat',
        avatar_url: 'https://avatars.test/octo',
        email: 'octo@example.test',
      });
    }
    return json(200, {
      sub: 'google-sub-1',
      email: 'person@example.test',
      email_verified: true,
      name: 'Person Example',
      picture: 'https://avatars.test/person',
    });
  };

  const linkCalls: LinkOrCreateAccountArgs[] = [];
  const service = {
    linkOrCreateAccount: (args: LinkOrCreateAccountArgs): Promise<LinkOrCreateAccountResult> => {
      linkCalls.push(args);
      return Promise.resolve(
        opts.linkResult ?? {
          kind: 'signed-in-existing-link',
          accountId: 'acct-1',
          linkId: 'link-1',
        },
      );
    },
  } as unknown as OAuthClientService;

  const sessionCalls: SessionCall[] = [];
  const authFlows = {
    issueOAuthWebSession: (args: SessionCall): Promise<OAuthWebSessionResult | null> => {
      sessionCalls.push(args);
      if (opts.sessionResult !== undefined) return Promise.resolve(opts.sessionResult);
      return Promise.resolve({
        kind: 'session',
        session: { plaintext: SESSION_PLAINTEXT, row: {} },
      } as unknown as OAuthWebSessionResult);
    },
  } as unknown as AuthFlowsService;

  const dashboardOrigin = opts.dashboardOrigin ?? DEFAULT_DASHBOARD_ORIGIN;
  registerOAuthClientRoutes(app, {
    service,
    authFlows,
    providers: { google: CREDS, github: CREDS },
    callbackUrlBase: CALLBACK_URL_BASE,
    dashboardOrigin,
    signingSecret: SIGNING_SECRET,
    logger: pino({ level: 'silent' }),
    rateLimitStore: new MemoryRateLimitStore(),
    fetch: fetchImpl,
    flowStore,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
  await app.ready();
  return {
    app,
    dashboardOrigin,
    store,
    storeSets,
    storeConsumes,
    idpCalls,
    linkCalls,
    sessionCalls,
  };
}

// ─── flow helpers ────────────────────────────────────────────────

/** What login.astro does before /start: a random secret, and its digest. */
export function mintBinding(): { secret: string; bindingHash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, bindingHash: createHash('sha256').update(secret).digest('base64url') };
}

export function stateOf(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (state === null) throw new Error('authorize_url carries no state');
  return state;
}

export function payloadOf(state: string): OAuthClientStatePayload {
  const res = verifyOauthClientState({ token: state, signingSecret: SIGNING_SECRET });
  if (res.kind !== 'ok') throw new Error(`state did not verify: ${res.kind}`);
  return res.payload;
}

export interface StartV2 {
  res: LightMyRequestResponse;
  authorizeUrl: string;
  state: string;
  flowId: string;
  secret: string;
  bindingHash: string;
}

/** The v2 /start a NEW bundle performs. */
export async function startV2(
  h: Harness,
  provider: Provider,
  redirectTo: string,
): Promise<StartV2> {
  const binding = mintBinding();
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/oauth-client/start',
    payload: { provider, redirect_to: redirectTo, binding_hash: binding.bindingHash },
  });
  const body = res.json<{ authorize_url?: string; flow_id?: string }>();
  return {
    res,
    authorizeUrl: body.authorize_url ?? '',
    state: body.authorize_url ? stateOf(body.authorize_url) : '',
    flowId: body.flow_id ?? '',
    secret: binding.secret,
    bindingHash: binding.bindingHash,
  };
}

export interface StartV1 {
  res: LightMyRequestResponse;
  authorizeUrl: string;
  state: string;
  /** `name=value` of the PKCE cookie, ready for a Cookie header. */
  cookie: string;
}

/** The legacy /start an OLD bundle performs (no binding_hash). */
export async function startV1(
  h: Harness,
  provider: Provider,
  redirectTo: string,
): Promise<StartV1> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/oauth-client/start',
    payload: { provider, redirect_to: redirectTo },
  });
  const body = res.json<{ authorize_url?: string }>();
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const pkce = cookies.find((c) => typeof c === 'string' && c.startsWith('ds_oauth_pkce_')) ?? '';
  return {
    res,
    authorizeUrl: body.authorize_url ?? '',
    state: body.authorize_url ? stateOf(body.authorize_url) : '',
    cookie: pkce.split(';')[0] ?? '',
  };
}

/** A state signed directly (never /start-ed) — an attacker's forgery is
 *  impossible without the secret, but a REPLAYED or config-drifted state
 *  looks exactly like this from the route's point of view. */
export function signState(
  overrides: Partial<{
    provider: Provider;
    redirectTo: string;
    nonce: string;
    bind: string;
    nowMs: number;
  }>,
): string {
  return signOauthClientState({
    provider: overrides.provider ?? 'google',
    redirectTo: overrides.redirectTo ?? `${DEFAULT_DASHBOARD_ORIGIN}/`,
    signingSecret: SIGNING_SECRET,
    ...(overrides.nonce !== undefined ? { nonce: overrides.nonce } : {}),
    ...(overrides.bind !== undefined ? { bind: overrides.bind } : {}),
    ...(overrides.nowMs !== undefined ? { nowMs: overrides.nowMs } : {}),
  });
}

/** The IDP's top-level return to the registered redirect_uri. */
export async function topLevel(
  h: Harness,
  provider: Provider,
  query: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const qs = new URLSearchParams(query).toString();
  return h.app.inject({
    method: 'GET',
    url: `/v1/auth/oauth/${provider}/callback${qs.length > 0 ? `?${qs}` : ''}`,
    headers,
  });
}

export async function redeem(
  h: Harness,
  code: string,
  flowSecret: string,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: 'POST',
    url: '/v1/auth/oauth-client/redeem',
    payload: { code, flow_secret: flowSecret },
  });
}

export function locationOf(res: LightMyRequestResponse): URL {
  const loc = res.headers.location;
  if (typeof loc !== 'string')
    throw new Error(`no Location header (status ${String(res.statusCode)})`);
  return new URL(loc);
}

export function fragmentOf(res: LightMyRequestResponse): URLSearchParams {
  const hash = locationOf(res).hash;
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** Runs /start (v2) + the top-level callback; returns the hand-off code. */
export async function completeToHandoff(
  h: Harness,
  provider: Provider = 'google',
  redirectTo = `${DEFAULT_DASHBOARD_ORIGIN}/usage`,
): Promise<{ start: StartV2; top: LightMyRequestResponse; code: string; flowId: string }> {
  const start = await startV2(h, provider, redirectTo);
  const top = await topLevel(h, provider, { code: IDP_CODE, state: start.state });
  const frag = fragmentOf(top);
  return { start, top, code: frag.get('code') ?? '', flowId: frag.get('flow') ?? '' };
}
