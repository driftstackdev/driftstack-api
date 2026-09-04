#!/usr/bin/env node
// Smoke test for OAuth-client go-live (V-667.C). Exercises the
// /v1/auth/oauth-client/start route against a live API for each
// provider you ask about, then checks that the returned authorize
// URL carries every PKCE-required query parameter. No IDP round-
// trip happens — the IDP would be a separate paid-third-party
// dependency, and exit codes from a "did the IDP accept us" test
// are very noisy. The shape of the authorize URL is enough to
// validate that:
//
//   1. The provider is configured server-side (no 400 on /start).
//   2. The state JWT is signed (non-empty `state` query param).
//   3. PKCE is wired (`code_challenge` + `code_challenge_method=S256`).
//   4. The callback URL matches what the operator wired.
//   5. The scope matches the provider's published default.
//
// Usage:
//   node scripts/smoke-oauth-client.mjs --base-url https://api.driftstack.dev
//   node scripts/smoke-oauth-client.mjs --base-url https://api.driftstack.dev --provider google
//
// Defaults: probes both google + github. Non-zero exit if any
// provider fails so CI can gate on it.

import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args['base-url'] ?? '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('error: --base-url <api origin> is required');
  process.exit(2);
}
const provider = args.provider;
const PROVIDERS = provider ? [provider] : ['google', 'github'];
for (const p of PROVIDERS) {
  if (p !== 'google' && p !== 'github') {
    console.error(`error: --provider must be google|github (got "${p}")`);
    process.exit(2);
  }
}

const REDIRECT_TO = args['redirect-to'] ?? `${baseUrl.replace(/api\./, 'app.')}/`;

const EXPECTED_QUERY = {
  google: {
    host: 'accounts.google.com',
    scope: 'openid email profile',
  },
  github: {
    host: 'github.com',
    scope: 'read:user user:email',
  },
};

let allOk = true;
for (const p of PROVIDERS) {
  const ok = await smoke(p);
  if (!ok) allOk = false;
}
// V-667.C-followup — also probe the customer-facing
// /v1/account/me/oauth-links route. 401 confirms route is registered
// + auth-gated as designed (the smoke doesn't have an account
// token, so 401 IS the right answer here).
const linksOk = await smokeAccountLinks();
if (!linksOk) allOk = false;
process.exit(allOk ? 0 : 1);

async function smokeAccountLinks() {
  const url = `${baseUrl}/v1/account/me/oauth-links`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      console.error(
        `FAIL /v1/account/me/oauth-links: 404 — AppDeps.oauthLinksRepo not wired (V-667.C-followup gate failed).`,
      );
      return false;
    }
    if (res.status !== 401) {
      console.error(`FAIL /v1/account/me/oauth-links: expected 401, got ${res.status}`);
      return false;
    }
    console.log('OK /v1/account/me/oauth-links: 401 (route registered + auth-gated)');
    return true;
  } catch (err) {
    console.error(`FAIL /v1/account/me/oauth-links: transport error: ${err.message}`);
    return false;
  }
}

async function smoke(p) {
  const url = `${baseUrl}/v1/auth/oauth-client/start`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: p, redirect_to: REDIRECT_TO }),
    });
  } catch (err) {
    console.error(`FAIL ${p}: transport error: ${err.message}`);
    return false;
  }
  if (res.status === 404) {
    console.error(
      `FAIL ${p}: /v1/auth/oauth-client/start returned 404 — route is not registered. ` +
        `Check that OAUTH_CLIENT_SIGNING_SECRET + OAUTH_CLIENT_CALLBACK_URL + at least one provider's ` +
        `CLIENT_ID/SECRET pair are set in /opt/driftstack/api/.env, then systemctl restart driftstack-api.`,
    );
    return false;
  }
  if (res.status === 400) {
    const body = await res.text();
    console.error(
      `FAIL ${p}: 400 from /start — likely missing creds for this provider. body=${body}`,
    );
    return false;
  }
  if (res.status !== 200) {
    const body = await res.text();
    console.error(`FAIL ${p}: unexpected status ${res.status}. body=${body}`);
    return false;
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch (err) {
    console.error(`FAIL ${p}: response body is not JSON: ${err.message}`);
    return false;
  }
  const authorizeUrl = parsed?.authorize_url;
  if (typeof authorizeUrl !== 'string' || authorizeUrl.length === 0) {
    console.error(`FAIL ${p}: response missing authorize_url`);
    return false;
  }

  const u = new URL(authorizeUrl);
  const expected = EXPECTED_QUERY[p];
  if (u.hostname !== expected.host) {
    console.error(`FAIL ${p}: authorize_url hostname ${u.hostname} !== expected ${expected.host}`);
    return false;
  }

  const required = [
    'client_id',
    'redirect_uri',
    'state',
    'response_type',
    'code_challenge',
    'code_challenge_method',
    'scope',
  ];
  for (const k of required) {
    if (!u.searchParams.has(k) || u.searchParams.get(k).length === 0) {
      console.error(`FAIL ${p}: authorize_url missing query param "${k}"`);
      return false;
    }
  }
  if (u.searchParams.get('response_type') !== 'code') {
    console.error(
      `FAIL ${p}: response_type must be "code", got "${u.searchParams.get('response_type')}"`,
    );
    return false;
  }
  if (u.searchParams.get('code_challenge_method') !== 'S256') {
    console.error(
      `FAIL ${p}: code_challenge_method must be "S256", got "${u.searchParams.get('code_challenge_method')}"`,
    );
    return false;
  }
  if (u.searchParams.get('scope') !== expected.scope) {
    console.error(
      `FAIL ${p}: scope "${u.searchParams.get('scope')}" !== expected "${expected.scope}"`,
    );
    return false;
  }

  // Path A (2026-05-16): the redirect_uri value MUST end with
  // `/${provider}/callback`. If the env wire of
  // OAUTH_CLIENT_CALLBACK_URL_BASE is missing or wrong (e.g. still
  // points at the SPA URL), the value will end with the wrong path
  // and the IDP will reject with redirect_uri_mismatch on the next
  // user-side authorize. Catch it here instead of at user
  // browser-time.
  const redirectUri = u.searchParams.get('redirect_uri');
  const expectedSuffix = `/${p}/callback`;
  if (!redirectUri.endsWith(expectedSuffix)) {
    console.error(
      `FAIL ${p}: redirect_uri "${redirectUri}" does not end with "${expectedSuffix}" — env OAUTH_CLIENT_CALLBACK_URL_BASE may be wrong (V-667.C Path A requires it to be the per-provider API origin)`,
    );
    return false;
  }
  // Also: redirect_uri must be on the API origin (api.driftstack.dev),
  // not the SPA origin (app.driftstack.io). The pre-Path-A wiring
  // pointed at the SPA URL; if we see that, fail loud.
  try {
    const redirectHost = new URL(redirectUri).hostname;
    if (redirectHost.startsWith('app.')) {
      console.error(
        `FAIL ${p}: redirect_uri "${redirectUri}" is on the SPA origin (app.*) — Path A requires the API origin (api.*). Update OAUTH_CLIENT_CALLBACK_URL_BASE in /opt/driftstack/api/.env.`,
      );
      return false;
    }
  } catch {
    console.error(`FAIL ${p}: redirect_uri "${redirectUri}" is not a parseable URL`);
    return false;
  }

  console.log(`OK ${p}: authorize_url has all expected PKCE + provider-specific query params.`);
  return true;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (typeof v === 'string' && !v.startsWith('--')) {
        out[k] = v;
        i += 1;
      } else {
        out[k] = 'true';
      }
    }
  }
  return out;
}
