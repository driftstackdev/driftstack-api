// W483 — errors.driftstack.dev static error-docs site.
//
// Every RFC-9457 problem+json the API emits carries a `type` URI under
// https://errors.driftstack.dev/<slug>. Until this site existed that domain
// was NXDOMAIN — a dead link in every error response (developers follow it).
// This generates one page per problem type + an index, from a content map
// whose slug set is drift-guarded against api-types PROBLEM_TYPES (see
// apps/server/tests/unit/errors-site-slug-parity.test.ts).
//
// Dependency-free by design: `node build.mjs` emits dist/. Deployed to the
// Cloudflare Pages project `driftstack-errors` (custom domain
// errors.driftstack.dev) via wrangler, same as the other Pages sites.

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');

// One catch-all security baseline for every generated error explainer, kept in
// public/_headers like every other Pages app rather than inline here. The CSP
// security-parity guard audits each surface from its SOURCE file; a policy that
// existed only as a string literal in a generator was deployed but never
// reviewed, which is how this one shipped unaudited.
const SECURITY_HEADERS = readFileSync(join(HERE, 'public', '_headers'), 'utf8');

/**
 * slug → { status, title, meaning, fix }. Titles + statuses mirror
 * apps/server/src/lib/errors.ts (the constructors that emit them).
 */
export const ERROR_PAGES = {
  'bad-request': {
    status: 400,
    title: 'Bad Request',
    meaning:
      'The request was malformed — unparseable JSON, a missing required field, or a value outside the accepted range.',
    fix: 'Check the `detail` field for the specific problem, fix the request body or parameters, and retry. The API reference documents every endpoint’s expected shape.',
  },
  'validation-failed': {
    status: 400,
    title: 'Validation Failed',
    meaning:
      'The request body parsed but failed schema validation — a field has the wrong type, an unknown key was sent, or a constraint (length, enum, format) was violated.',
    fix: 'The `detail` field carries the validator output naming each offending field. Align the request with the documented schema and retry.',
  },
  unauthorized: {
    status: 401,
    title: 'Unauthorized',
    meaning: 'No credentials were supplied on a protected endpoint.',
    fix: 'Send your API key as a bearer token: `Authorization: Bearer ds_live_…`. Keys are minted in the dashboard under API keys.',
  },
  'invalid-key': {
    status: 401,
    title: 'Invalid API key',
    meaning: 'The supplied API key is not recognised.',
    fix: 'Check for truncation or whitespace; confirm you are using the key’s full value (shown once at mint time). If lost, mint a new key in the dashboard.',
  },
  'revoked-key': {
    status: 401,
    title: 'API key revoked',
    meaning: 'This key was explicitly revoked and can no longer be used.',
    fix: 'Mint a new key in the dashboard and update your deployment’s secret store.',
  },
  'expired-key': {
    status: 401,
    title: 'API key expired',
    meaning:
      'This key reached its expiry (set at mint time, or via rotation grace) and is no longer valid.',
    fix: 'Rotate to a fresh key (`POST /v1/api-keys/{id}/rotate`) or mint a new one in the dashboard.',
  },
  forbidden: {
    status: 403,
    title: 'Forbidden',
    meaning:
      'The credentials are valid but not allowed to perform this operation — wrong scope (e.g. a read-only key calling a write endpoint) or wrong role.',
    fix: 'Use a key with the `write` scope for mutating calls, or have the account owner perform the operation.',
  },
  'not-found': {
    status: 404,
    title: 'Not Found',
    meaning:
      'No resource with that id exists on your account. Cross-account resources intentionally return 404 (not 403) so existence is not leaked.',
    fix: 'Check the id; list the collection endpoint to confirm what exists on your account.',
  },
  conflict: {
    status: 409,
    title: 'Conflict',
    meaning:
      'The operation conflicts with the resource’s current state — e.g. acting on a session that has already ended.',
    fix: 'Fetch the resource’s current state, then decide whether the operation still applies.',
  },
  'rate-limited': {
    status: 429,
    title: 'Too Many Requests',
    meaning: 'You exceeded the request rate limit for this endpoint class.',
    fix: 'Honour the `Retry-After` header and back off. The SDKs retry this automatically with exponential backoff.',
  },
  'concurrency-limit': {
    status: 429,
    title: 'Concurrent session limit reached',
    meaning:
      'Your tier allows N simultaneous sessions and they are all in use; creating another would exceed the cap.',
    fix: 'Destroy an idle session, wait for one to finish, or upgrade to a tier with a higher concurrent cap. The error body carries `current_sessions` and `limit`.',
  },
  'tier-limit': {
    status: 429,
    title: 'Tier limit reached',
    meaning: 'A per-tier resource cap (e.g. profile count) is exhausted.',
    fix: 'Delete unused resources or upgrade your tier. The error body names the limit that was hit.',
  },
  'storage-quota-exceeded': {
    status: 409,
    title: 'Storage quota reached',
    meaning:
      'A profile-backed session-launch was refused because your profiles’ combined stored size reached your tier’s storage cap. The body carries used_bytes, cap_bytes, and tier. Sessions without a profile are never blocked; Enterprise is soft-only.',
    fix: 'Delete or trim a profile to free space, or upgrade your tier, then launch again.',
  },
  'proxy-validation-failed': {
    status: 422,
    title: 'Proxy validation failed',
    meaning:
      'The proxy attached to this launch failed a LIVE pre-launch connectivity test — the server connected THROUGH your proxy and ran a real egress round-trip, which did not succeed. The launch was blocked before any session or worker started. The body carries a `reason`: `unreachable` (host/port wrong or offline), `auth_failed` (bad credentials), `timeout` (proxy too slow), or `egress_blocked` (proxy connects but its upstream can’t reach the internet).',
    fix: 'Fix the proxy per the `reason` — verify host/port and that it is online, re-enter credentials, or check the proxy’s own upstream egress — then launch again.',
  },
  'profile-in-use': {
    status: 409,
    title: 'Profile already in use',
    meaning:
      'A session-create carried a profile_id that already has a live (non-terminal) session. A profile can run only one session at a time — two sessions on the same profile would both restore and then overwrite the same saved cookies and logins, losing your data. The body carries active_session_id, the live session you already have running. Sessions without a profile_id are never affected.',
    fix: 'End the session named in active_session_id (or wait for it to finish), then launch again. If you need parallel runs, use separate profiles.',
  },
  'session-destroyed': {
    status: 410,
    title: 'Session destroyed',
    meaning:
      'The session this call targets has already been destroyed; it cannot accept further operations.',
    fix: 'Create a new session. If you need state across sessions, attach a persistent profile.',
  },
  'session-timeout': {
    status: 504,
    title: 'Session timeout',
    meaning:
      'The in-session operation (navigate, interact, wait) did not complete within its time budget.',
    fix: 'Retry the operation; for slow pages raise the wait condition’s timeout, or split long flows into smaller steps.',
  },
  'driver-error': {
    status: 502,
    title: 'Driver error',
    meaning:
      'The browser driver reported a failure executing the operation (e.g. the selector matched nothing, or the page navigated mid-action).',
    fix: 'Check the `detail` for the driver message. Verify selectors against the live page state (`GET /v1/sessions/{id}/state`) and retry.',
  },
  'driver-not-integrated': {
    status: 503,
    title: 'Driver not integrated',
    meaning:
      'This deployment does not have a live browser fleet wired (e.g. a self-hosted control plane before workers register).',
    fix: 'Operator action: register a worker node. Cloud customers should not see this — contact support@driftstack.dev if you do.',
  },
  'feature-unavailable': {
    status: 503,
    title: 'Feature unavailable',
    meaning:
      'The feature exists but is disabled in this deployment (an activation gate is off — e.g. billing, agent sessions, or avatar upload without its bucket).',
    fix: 'The `detail` explains what is missing and any self-serve option. Cloud features come online per the changelog; self-hosted operators enable the relevant env config.',
  },
  'byok-anthropic-required': {
    status: 502,
    title: 'BYOK Anthropic key required',
    meaning:
      'An AI agent-session turn needs an Anthropic API key and none is available on your account.',
    fix: 'Store a key via `PUT /v1/account/me/byok-anthropic-key` (or send `x-byok-anthropic-api-key` per request), or opt in to the bundled-LLM budget in Settings.',
  },
  'pair-mode-conflict': {
    status: 409,
    title: 'Pair-mode takeover already in flight',
    meaning: 'Another client already requested takeover of this pair-mode session.',
    fix: 'Wait for the in-flight transition to settle (watch the `pair_mode_state` on the session), then retry if still needed.',
  },
  'pair-mode-invalid-transition': {
    status: 409,
    title: 'Invalid pair-mode transition',
    meaning:
      'The requested pair-mode transition is not legal from the session’s current state (e.g. handback when no human is driving).',
    fix: 'Read `from` and `transition` in the error body; fetch the session to see the current `pair_mode_state` and drive the state machine from there.',
  },
  'bundled-llm-consent-required': {
    status: 402,
    title: 'Bundled-LLM consent required',
    meaning:
      'The agent turn would bill the deployment’s bundled LLM, and your account has not opted in.',
    fix: 'Opt in via `PATCH /v1/account/me/bundled-llm-settings` (sets the monthly cap), or supply your own Anthropic key (BYOK always wins).',
  },
  'bundled-llm-budget-exhausted': {
    status: 402,
    title: 'Bundled-LLM monthly cap reached',
    meaning: 'Your bundled-LLM spend hit your configured monthly cap.',
    fix: 'Raise the cap via `PATCH /v1/account/me/bundled-llm-settings`, or supply a BYOK Anthropic key. The cap resets at the start of each calendar month.',
  },
  'mfa-step-up-required': {
    status: 403,
    title: 'MFA step-up required',
    meaning:
      'This sensitive operation requires a fresh MFA confirmation (the error body carries `requires_mfa_step_up: true`).',
    fix: 'Collect a current 6-digit code, post it to `/v1/auth/mfa/step-up`, then retry the original request.',
  },
  'legal-acceptance-required': {
    status: 409,
    title: 'Legal acceptance required',
    meaning:
      'A new version of the terms/policies must be accepted before this operation can proceed.',
    fix: 'Fetch `GET /v1/legal/required` and accept via `POST /v1/legal/accept` (the dashboard prompts this automatically), then retry.',
  },
  'email-already-registered': {
    status: 409,
    title: 'Email already registered',
    meaning: 'An account with this email already exists.',
    fix: 'Sign in instead, use password reset if needed, or sign in with the identity provider originally linked.',
  },
  'invalid-credentials': {
    status: 401,
    title: 'Invalid credentials',
    meaning: 'The email/password combination did not match.',
    fix: 'Retry, or use “Forgot password” to reset. Repeated failures are rate-limited.',
  },
  'invalid-auth-token': {
    status: 400,
    title: 'Invalid auth token',
    meaning:
      'The one-time token (email verification, magic link, password reset, invite) is malformed, expired, or already used.',
    fix: 'Request a fresh link — these tokens are single-use and short-lived by design.',
  },
  'email-not-verified': {
    status: 403,
    title: 'Email not verified',
    meaning: 'The account exists but its email has not been verified yet.',
    fix: 'Click the link in the verification email, or request a new one via `POST /v1/auth/resend-verification`.',
  },
  internal: {
    status: 500,
    title: 'Internal Server Error',
    meaning:
      'An unexpected error on our side. The response’s `instance` field is a correlation id our logs index.',
    fix: 'Retry; if it persists, email support@driftstack.dev with the `instance` id and we can trace the exact request.',
  },
};

// W556 — cross-links between errors a developer commonly confuses or hits in
// sequence (the three 429s, the key/auth family, the LLM rails, etc.). Every
// key + value must be a slug in ERROR_PAGES (guarded by the slug-parity test).
export const RELATED = {
  'rate-limited': ['concurrency-limit', 'tier-limit'],
  'concurrency-limit': ['rate-limited', 'tier-limit'],
  'tier-limit': ['concurrency-limit', 'rate-limited', 'storage-quota-exceeded'],
  'storage-quota-exceeded': ['tier-limit', 'conflict'],
  'profile-in-use': ['conflict', 'concurrency-limit', 'storage-quota-exceeded'],
  unauthorized: ['invalid-key', 'invalid-credentials', 'forbidden'],
  forbidden: ['unauthorized', 'mfa-step-up-required'],
  'mfa-step-up-required': ['forbidden', 'unauthorized'],
  'invalid-key': ['revoked-key', 'expired-key', 'unauthorized'],
  'revoked-key': ['invalid-key', 'expired-key'],
  'expired-key': ['invalid-key', 'revoked-key'],
  'invalid-credentials': ['unauthorized', 'invalid-auth-token'],
  'invalid-auth-token': ['invalid-credentials', 'email-not-verified'],
  'email-not-verified': ['email-already-registered', 'invalid-auth-token'],
  'email-already-registered': ['email-not-verified', 'invalid-credentials'],
  'session-destroyed': ['session-timeout', 'not-found'],
  'session-timeout': ['session-destroyed', 'driver-error'],
  'driver-error': ['driver-not-integrated', 'session-timeout'],
  'driver-not-integrated': ['driver-error', 'feature-unavailable'],
  'feature-unavailable': ['driver-not-integrated'],
  'byok-anthropic-required': ['bundled-llm-consent-required', 'bundled-llm-budget-exhausted'],
  'bundled-llm-consent-required': ['byok-anthropic-required', 'bundled-llm-budget-exhausted'],
  'bundled-llm-budget-exhausted': ['bundled-llm-consent-required', 'byok-anthropic-required'],
  'pair-mode-conflict': ['pair-mode-invalid-transition'],
  'pair-mode-invalid-transition': ['pair-mode-conflict'],
  'legal-acceptance-required': ['forbidden'],
};

const css = `
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0f14;color:#e8edf2;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:48px 24px}
main{max-width:680px;margin:0 auto}
a{color:#e5484d;text-decoration:underline;text-underline-offset:4px}
.label{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#e5484d}
h1{font-size:28px;letter-spacing:-.02em;margin:14px 0 4px}
.status{font-family:ui-monospace,monospace;font-size:13px;color:#9ba6b2;margin-bottom:24px}
h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:#9ba6b2;margin:26px 0 8px}
p{color:#c4cdd6}
code{font-family:ui-monospace,monospace;font-size:.92em;background:#151b23;border:1px solid #232b36;border-radius:4px;padding:1px 5px}
ul{list-style:none}
li{border-bottom:1px solid #1a2129;padding:10px 0}
li code{background:none;border:none;padding:0;color:#9ba6b2}
footer{margin-top:48px;font-size:13px;color:#5c6770}
`.trim();

const escapeAttribute = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const page = (title, body, { description, canonicalPath, noindex = false }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0f14"><meta name="description" content="${escapeAttribute(description)}"><meta name="robots" content="${noindex ? 'noindex,nofollow' : 'index,follow'}">${
  !noindex && canonicalPath
    ? `<link rel="canonical" href="https://errors.driftstack.dev${canonicalPath}">`
    : ''
}<title>${title} · Driftstack errors</title><style>${css}</style></head>
<body><main>${body}<footer>Driftstack API error reference · <a href="https://docs.driftstack.dev">docs</a> · <a href="https://driftstack.dev">driftstack.dev</a></footer></main></body></html>`;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, '_headers'), SECURITY_HEADERS);

const slugs = Object.keys(ERROR_PAGES).sort();
for (const slug of slugs) {
  const e = ERROR_PAGES[slug];
  mkdirSync(join(DIST, slug), { recursive: true });
  writeFileSync(
    join(DIST, slug, 'index.html'),
    page(
      e.title,
      `<p class="label">API error type</p><h1>${e.title}</h1><p class="status">HTTP ${e.status} · <code>https://errors.driftstack.dev/${slug}</code></p>
<h2>What it means</h2><p>${e.meaning}</p>
<h2>How to fix it</h2><p>${e.fix}</p>
<h2>Where it appears</h2><p>In the <code>type</code> field of the <a href="https://www.rfc-editor.org/rfc/rfc9457">RFC 9457</a> <code>application/problem+json</code> error body, alongside <code>title</code>, <code>status</code>, <code>detail</code>, and an <code>instance</code> correlation id.</p>${
        (RELATED[slug] ?? []).length > 0
          ? `<h2>Related</h2><ul>${RELATED[slug]
              .map(
                (r) => `<li><a href="/${r}">${ERROR_PAGES[r].title}</a> <code>· /${r}</code></li>`,
              )
              .join('')}</ul>`
          : ''
      }`,
      {
        description: `Learn what the Driftstack API “${e.title}” error means and how to fix it.`,
        canonicalPath: `/${slug}/`,
      },
    ),
  );
}
// W558 — group the index by HTTP status class so it's scannable (was a flat
// 29-item list). Buckets in ascending status order; a slug lands in exactly one.
const STATUS_GROUPS = [
  { label: '4xx — client errors', test: (s) => s >= 400 && s < 500 },
  { label: '5xx — server / upstream errors', test: (s) => s >= 500 },
];
const groupsHtml = STATUS_GROUPS.map((g) => {
  const rows = slugs
    .filter((s) => g.test(ERROR_PAGES[s].status))
    .sort((a, b) => ERROR_PAGES[a].status - ERROR_PAGES[b].status)
    .map(
      (s) =>
        `<li><a href="/${s}">${ERROR_PAGES[s].title}</a> <code>· ${ERROR_PAGES[s].status} · /${s}</code></li>`,
    )
    .join('\n');
  return rows.length > 0 ? `<h2>${g.label}</h2><ul>${rows}</ul>` : '';
}).join('\n');
writeFileSync(
  join(DIST, 'index.html'),
  page(
    'Error reference',
    `<p class="label">Driftstack</p><h1>API error reference</h1><p class="status">${slugs.length} problem types</p>
<p>Every Driftstack API error is an <a href="https://www.rfc-editor.org/rfc/rfc9457">RFC 9457</a> <code>application/problem+json</code> body whose <code>type</code> URI points at one of these pages.</p>
${groupsHtml}`,
    {
      description:
        'Reference for every Driftstack API RFC 9457 problem type, including its HTTP status, meaning, and recommended fix.',
      canonicalPath: '/',
    },
  ),
);
// 404 → index (Pages serves 404.html for unknown paths).
writeFileSync(
  join(DIST, '404.html'),
  page(
    'Unknown error type',
    `<p class="label">Driftstack</p><h1>Unknown error type</h1><p>No page for that error slug. See the <a href="/">full error reference</a>.</p>`,
    {
      description: 'The requested Driftstack API error type does not exist.',
      canonicalPath: undefined,
      noindex: true,
    },
  ),
);
console.log(`errors-site: built ${slugs.length} error pages + index + 404 → dist/`);
