// Credential redaction for recipe step results.
//
// A `RecipeStepResult` embeds the executed `RecipeStep` for observability.
// Step fields can carry credentials, so a runner that logs / persists /
// returns a RecipeResult would leak plaintext — the same class as the SSE
// token-in-log leak (V-494 redact posture). The result is for reporting, NOT
// re-execution, so the plaintext is never needed there.
//
// Three credential vectors:
//   - `type`-step `text` — the inlined password/secret typed into a field
//     (e.g. buildLoginRecipe). Fully redacted.
//   - URL credentials in a `navigate` `url` or a `wait` url-condition `value`:
//     basic-auth userinfo (`https://user:pass@host`), secret-bearing query
//     params (`?token=…`, `?password=…`), secret-bearing fragment params
//     (`#access_token=…` — the OAuth implicit/hybrid post-auth redirect vector),
//     AND secret-shaped PATH segments (`/reset-password/<token>`,
//     `/confirm/<jwt>` — the Devise/Rails password-reset+confirmation and
//     magic-link/passwordless-login vector: the secret has no query-param key
//     to match against, so it's flagged by shape/context instead — see
//     `redactPathCredentials`). Stripped/redacted in place so the host + path
//     stay legible for debugging but the secret never lands in the result. A
//     clean URL (no userinfo, no sensitive params/segments) is returned
//     byte-for-byte unchanged — no URL normalization — so non-secret steps keep
//     their exact original value (and reference).
//   - `RecipeContext.metadata` — free-form per-run metadata the caller attaches
//     (types.ts). It sits OUTSIDE `RecipeStep`, so `redactStepForResult` can't
//     see it; `redactMetadata` is the parallel chokepoint for it (same
//     redact-the-known-secrets posture: credential-suggestive KEY names are
//     redacted regardless of value shape, and string values that are
//     themselves credential-bearing URLs are run through the same URL
//     redaction as above).
//
// `redactStepForResult` (for `RecipeStep`) and `redactMetadata` (for
// `RecipeContext.metadata`) are the TWO required chokepoints: the mock runner
// uses both, and the real Phase-3 runner MUST build its RecipeStepResult.step
// AND any surfaced metadata through them too, so redaction holds by
// construction regardless of the runner. Neither call covers the other's
// input — a runner that only calls one of the two still leaks the other
// vector.

import type { RecipeStep } from './types.js';

/** Placeholder substituted for any secret-bearing field in a result step. */
export const REDACTED = '[redacted]';

// Query-param names whose VALUES are treated as secrets in a URL. Lowercased
// for case-insensitive matching. Conservative, well-known set — a param not
// listed is left visible (observability), so this is a redact-the-known-secrets
// posture, not a fail-closed allowlist.
//
// Includes common password-reset / email-confirmation / passwordless-login /
// MFA param names (`reset_token`, `confirmation_token`, `jwt`, `otp`, …) in
// addition to the original OAuth/basic-secret set.
const SECRET_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'key',
  'auth',
  'authorization',
  'code',
  'sig',
  'signature',
  'session',
  'sid',
  'reset_token',
  'confirmation_token',
  'verification_token',
  'verification_code',
  'magic_token',
  'jwt',
  'otp',
  // V-1717 — this product's OWN token parameters, which a known-secrets list had
  // no business omitting. `ds_token` is published as a query parameter on the
  // account notification stream, so a recipe navigating a Driftstack URL carried
  // it into a step result in clear. The other four are the central redactor's
  // (`apps/server/src/lib/redact-url.ts`) and are unambiguously secret-bearing.
  'ds_token',
  'session_token',
  'challenge_token',
  'debug_token',
  'code_verifier',
  // ⛔ `state` is deliberately NOT here, though the central redactor scrubs it.
  // In OAuth `state` is CSRF protection, not a secret — it is meant to be
  // comparable by the client and is routinely logged. The central list scrubs it
  // because a log line is not worth the argument; a step result is for a human
  // reading back what a recipe did, and redacting a non-secret there costs
  // observability for no gain. The two lists diverge here ON PURPOSE.
]);

/**
 * Normalize a query/fragment param key for matching against
 * `SECRET_QUERY_PARAMS`: lowercase, and strip a trailing PHP/Rails-style
 * array-index suffix (`token[]`, `token[0]`, `token[12]` all normalize to
 * `token`). Without this, `?token[]=leak1&token[]=leak2` bypasses the
 * denylist entirely because the literal key `token[]` never exact-matches
 * the listed `token` — the values still leak even though the base name is
 * a known secret.
 *
 * A broader substring/contains match (key CONTAINS "token"/"secret"/…) was
 * considered instead of a hardcoded list, but rejected: it would sweep up
 * benign params that merely contain one of these words as a substring (e.g.
 * `tokenizer_version`, `auth_time_zone`), which this module's stated
 * "redact-the-known-secrets, not fail-closed" posture (see the comment on
 * `SECRET_QUERY_PARAMS` above) argues against. Suffix-stripped exact match
 * against a maintained list keeps the same conservative posture while
 * closing the array-suffix bypass.
 */
function normalizeQueryParamKey(key: string): string {
  return key.toLowerCase().replace(/\[\d*\]$/, '');
}

// Path segments whose PRECEDING segment name signals a credential-delivery
// context: password-reset / email-confirmation / magic-link / passwordless-
// login flows commonly embed the secret as the NEXT raw path segment, not a
// query param — e.g. Rails/Devise `/reset-password/:token` and
// `/confirmation/:token`, Firebase Dynamic Links, and various magic-link
// providers. Normalized (lowercased, non-alphanumeric characters stripped)
// before comparison so `reset-password`, `reset_password`, and
// `ResetPassword` all match the same entry.
//
// Deliberately an EXACT match against this small well-known set — same
// conservative "redact-the-known-secrets" posture as `SECRET_QUERY_PARAMS`
// above — rather than a substring/contains check, so an unrelated segment
// that merely CONTAINS one of these words (e.g. `authentic-leather`,
// `session-replay-demo`) is not mistaken for a credential-context marker and
// doesn't cause the NEXT segment to be redacted.
const SENSITIVE_PRECEDING_PATH_SEGMENTS = new Set([
  'reset',
  'resetpassword',
  'passwordreset',
  'confirm',
  'confirmation',
  'confirmemail',
  'verify',
  'verification',
  'verifyemail',
  'magic',
  'magiclink',
  'token',
  'auth',
  'activate',
  'activation',
  'unsubscribe',
  'invite',
  'invitation',
  'session',
]);

/**
 * JWT shape: three base64url segments separated by `.`
 * (header.payload.signature). Header and payload each require a real minimum
 * length so a short dotted string that only superficially LOOKS like three
 * dot-separated tokens (e.g. a `1.2.3` semver path segment) doesn't
 * false-positive; the signature part may be empty (`alg: none`).
 */
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*$/;

/**
 * A long, opaque-looking, base64url-ish path segment — the shape a
 * reset/confirmation/magic-link token takes when embedded directly in the
 * path (there's no query-param KEY to match against there, unlike
 * `SECRET_QUERY_PARAMS`, so shape + preceding-segment context stand in for
 * it). Requires at least one letter so a long PURELY NUMERIC segment (e.g.
 * an order or confirmation reference number) isn't swept up.
 */
const TOKEN_LIKE_PATH_SEGMENT_RE = /^(?=.*[A-Za-z])[A-Za-z0-9_-]{16,}$/;

function normalizePathSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Redact path segments that look like embedded credentials: a JWT-shaped
 * segment anywhere in the path (unambiguous by shape alone), OR a long
 * token-looking segment immediately following a credential-suggestive
 * segment name (see `SENSITIVE_PRECEDING_PATH_SEGMENTS`). A bare short
 * segment like `123` in `/users/123/profile`, or a normal word like
 * `blue-shirt`, matches neither rule and is left untouched. Returns the
 * ORIGINAL pathname (same reference) when nothing matches.
 */
function redactPathCredentials(pathname: string): { pathname: string; changed: boolean } {
  const segments = pathname.split('/');
  let changed = false;
  const redactedSegments = segments.map((segment, i) => {
    if (segment === '') return segment; // leading/trailing slash artifact
    if (JWT_SHAPE_RE.test(segment)) {
      changed = true;
      return encodeURIComponent(REDACTED);
    }
    const prev = i > 0 ? normalizePathSegment(segments[i - 1] ?? '') : '';
    if (TOKEN_LIKE_PATH_SEGMENT_RE.test(segment) && SENSITIVE_PRECEDING_PATH_SEGMENTS.has(prev)) {
      changed = true;
      return encodeURIComponent(REDACTED);
    }
    return segment;
  });
  return { pathname: changed ? redactedSegments.join('/') : pathname, changed };
}

/**
 * Strip credentials from a URL string: remove basic-auth userinfo, redact
 * secret-shaped path segments, and redact the values of known secret-bearing
 * query params (+ the same in the fragment's query suffix, see below).
 * Returns the ORIGINAL string unchanged (no normalization) when there's
 * nothing to redact, and also when the value isn't a parseable absolute URL
 * (a non-URL string can't carry structured URL credentials, and we don't want
 * to corrupt it).
 */
function redactUrlCredentials(url: string): string {
  let parsed: URL;
  let relative = false;
  try {
    parsed = new URL(url);
  } catch {
    // A RELATIVE URL / path still carries the SAME path / query / fragment
    // credential vectors — e.g. a `wait:url` value `/account/reset/<token>/edit`
    // or a stashed relative post-auth redirect `/confirm/<jwt>`. Without this
    // the whole absolute-only redaction (path-token / query-secret / fragment-
    // token) is bypassed for relative inputs and the secret leaks into the
    // result verbatim. Parse against a sentinel base (`.invalid` never resolves)
    // so the same redaction applies, then strip the base back off below. A truly
    // unparseable string is still left untouched (it can't carry structured
    // credentials).
    try {
      parsed = new URL(url, 'http://driftstack.invalid/');
      relative = true;
    } catch {
      return url;
    }
  }
  let changed = false;
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(normalizeQueryParamKey(key))) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  const pathResult = redactPathCredentials(parsed.pathname);
  if (pathResult.changed) {
    parsed.pathname = pathResult.pathname;
    changed = true;
  }
  // OAuth implicit/hybrid flows return tokens in the URL FRAGMENT, which
  // `searchParams` does NOT cover — the same post-auth-redirect token vector
  // the `wait:url` path anticipates, just after the `#`. Two fragment shapes
  // carry these tokens:
  //
  //   1. Flat:        `#access_token=…&id_token=…`        — the classic
  //      OAuth implicit/hybrid response_mode=fragment shape.
  //   2. Hash-router: `#/dashboard?access_token=…&code=…` — an SPA whose
  //      router lives under the `#`, so the token query sits AFTER a `?`
  //      INSIDE the fragment.
  //
  // A naive `new URLSearchParams(fragment)` only handles shape 1: for shape 2
  // it treats the entire `/dashboard?access_token` run up to the first `=` as a
  // single key, so the secret VALUE survives untouched into the result (leak),
  // and round-tripping mangles the route prefix. Split on the first `?` so the
  // route prefix (`/dashboard`) is preserved verbatim and only the query suffix
  // is parsed + redacted. Only rebuilt when a secret key is actually present,
  // so a non-secret fragment (`#section`, `#/spa/route`, `#/route?foo=bar`) is
  // left byte-for-byte untouched (URLSearchParams round-tripping would
  // otherwise re-encode it).
  if (parsed.hash.length > 1) {
    const rawFrag = parsed.hash.slice(1);
    const qIdx = rawFrag.indexOf('?');
    // Hash-router shape: everything before the first `?` is the route prefix
    // (kept verbatim); only the suffix is a query string. Flat shape: no `?`,
    // so the whole fragment is the query string and the prefix is empty.
    const routePrefix = qIdx === -1 ? '' : rawFrag.slice(0, qIdx);
    const queryPart = qIdx === -1 ? rawFrag : rawFrag.slice(qIdx + 1);
    const frag = new URLSearchParams(queryPart);
    let fragChanged = false;
    for (const key of [...frag.keys()]) {
      if (SECRET_QUERY_PARAMS.has(normalizeQueryParamKey(key))) {
        frag.set(key, REDACTED);
        fragChanged = true;
      }
    }
    if (fragChanged) {
      const rebuiltQuery = frag.toString();
      // Re-attach the route prefix + `?` only when there was one, so a flat
      // fragment stays `#k=v` (no spurious leading `?`).
      parsed.hash = qIdx === -1 ? `#${rebuiltQuery}` : `#${routePrefix}?${rebuiltQuery}`;
      changed = true;
    }
  }
  if (!changed) return url;
  // Relative input: return only path + query + fragment, never the sentinel
  // origin. A clean relative URL was already returned byte-for-byte above, so
  // this only runs on an already-redacted value where a leading slash the
  // base-parse normalized in is acceptable (the secret is what mattered).
  return relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}

/**
 * Return a copy of `step` safe to embed in a RecipeStepResult — secret-bearing
 * fields replaced with {@link REDACTED} (or, for URLs, stripped in place). Steps
 * with nothing to redact are returned unchanged (same reference).
 */
export function redactStepForResult(step: RecipeStep): RecipeStep {
  if (step.kind === 'type') {
    return { ...step, text: REDACTED };
  }
  if (step.kind === 'navigate') {
    const safe = redactUrlCredentials(step.url);
    return safe === step.url ? step : { ...step, url: safe };
  }
  // `wait` with condition 'url' carries a URL to wait for (e.g. a post-auth
  // redirect that may embed a token); redact it the same way. Other wait
  // conditions ('selector' / 'time') aren't credential vectors.
  if (step.kind === 'wait' && step.condition === 'url' && typeof step.value === 'string') {
    const safe = redactUrlCredentials(step.value);
    return safe === step.value ? step : { ...step, value: safe };
  }
  return step;
}

/**
 * Metadata key names (normalized: lowercased, non-alphanumeric stripped)
 * treated as credential-bearing regardless of the value's shape — the
 * `RecipeContext.metadata` analogue of `SECRET_QUERY_PARAMS`. Derived from
 * `SECRET_QUERY_PARAMS` (so the two lists don't drift apart) plus a couple of
 * combined-word variants that are common METADATA key names in their own
 * right but don't literally appear as a single query-param name (e.g.
 * `auth_token` isn't in `SECRET_QUERY_PARAMS` — it has `auth` and `token`
 * as separate entries — but `authToken`/`auth_token` is a very common
 * metadata key).
 */
const SECRET_METADATA_KEY_STEMS = new Set([
  ...[...SECRET_QUERY_PARAMS].map(normalizeMetadataKey),
  'authtoken',
]);

function normalizeMetadataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Redact a `RecipeContext.metadata` bag for safe embedding in a surfaced
 * result/log — the parallel chokepoint to {@link redactStepForResult}, which
 * only ever sees a `RecipeStep` and never `RecipeContext.metadata` (see the
 * module header). Two independent checks, either of which redacts a value:
 *
 *   - the KEY looks credential-suggestive by name (same denylist posture as
 *     `SECRET_QUERY_PARAMS`, see `SECRET_METADATA_KEY_STEMS`) — the value is
 *     replaced with {@link REDACTED} regardless of its shape/type, since an
 *     opaque secret could be a string, number-like token, etc.
 *   - the VALUE is itself a string that carries structured URL credentials
 *     (userinfo / secret query-param / secret fragment-param / secret path
 *     segment) — redacted via the same {@link redactUrlCredentials} used for
 *     `navigate`/`wait` steps, so a metadata value that happens to be a
 *     credential-bearing URL (e.g. a stashed post-auth redirect) is covered
 *     too.
 *
 * Non-secret keys/values are returned unchanged. Bags with nothing to redact
 * are returned unchanged (same reference), matching `redactStepForResult`'s
 * contract. Only top-level keys/values are inspected — no recursion into
 * nested objects/arrays, consistent with this module's conservative
 * redact-what-you-can-confidently-flag posture (a nested-object heuristic
 * risks over-redacting arbitrary caller-shaped data).
 */
export function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_METADATA_KEY_STEMS.has(normalizeMetadataKey(key))) {
      out[key] = REDACTED;
      changed = true;
      continue;
    }
    if (typeof value === 'string') {
      const safe = redactUrlCredentials(value);
      if (safe !== value) {
        out[key] = safe;
        changed = true;
        continue;
      }
    }
    out[key] = value;
  }
  return changed ? out : metadata;
}
