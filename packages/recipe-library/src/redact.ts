// Credential redaction for recipe step results.
//
// A `RecipeStepResult` embeds the executed `RecipeStep` for observability.
// Step fields can carry credentials, so a runner that logs / persists /
// returns a RecipeResult would leak plaintext — the same class as the SSE
// token-in-log leak (V-494 redact posture). The result is for reporting, NOT
// re-execution, so the plaintext is never needed there.
//
// Two credential vectors:
//   - `type`-step `text` — the inlined password/secret typed into a field
//     (e.g. buildLoginRecipe). Fully redacted.
//   - URL credentials in a `navigate` `url` or a `wait` url-condition `value`:
//     basic-auth userinfo (`https://user:pass@host`), secret-bearing query
//     params (`?token=…`, `?password=…`), AND secret-bearing fragment params
//     (`#access_token=…` — the OAuth implicit/hybrid post-auth redirect vector).
//     Stripped/redacted in place so the
//     host + path stay legible for debugging but the secret never lands in the
//     result. A clean URL (no userinfo, no sensitive params) is returned
//     byte-for-byte unchanged — no URL normalization — so non-secret steps keep
//     their exact original value (and reference).
//
// `redactStepForResult` is the single chokepoint: the mock runner uses it, and
// the real Phase-3 runner MUST build its RecipeStepResult.step through it too,
// so redaction holds by construction regardless of the runner.

import type { RecipeStep } from './types.js';

/** Placeholder substituted for any secret-bearing field in a result step. */
export const REDACTED = '[redacted]';

// Query-param names whose VALUES are treated as secrets in a URL. Lowercased
// for case-insensitive matching. Conservative, well-known set — a param not
// listed is left visible (observability), so this is a redact-the-known-secrets
// posture, not a fail-closed allowlist.
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
]);

/**
 * Strip credentials from a URL string: remove basic-auth userinfo and redact
 * the values of known secret-bearing query params. Returns the ORIGINAL string
 * unchanged (no normalization) when there's nothing to redact, and also when
 * the value isn't a parseable absolute URL (a non-URL string can't carry
 * structured URL credentials, and we don't want to corrupt it).
 */
function redactUrlCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // not an absolute URL → not a structured-credential vector
  }
  let changed = false;
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
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
      if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) {
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
  return changed ? parsed.toString() : url;
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
