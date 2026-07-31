// Every credential-bearing query parameter the server ACCEPTS is redacted
// before a URL reaches a log or Sentry.
//
// `redact-url.test.ts` proves the redactor behaves correctly for the keys it
// already knows. Nothing proves that set is COMPLETE. `SENSITIVE_QUERY_KEYS` is
// a hand-maintained list in `lib/redact-url.ts`, and the failure mode is adding
// a route that reads `?reset_token=` without touching that list: the redactor
// keeps passing every one of its own tests while the credential starts landing
// in nginx access logs and Sentry `request.url`.
//
// That is not hypothetical here. `?ds_token=` exists precisely because
// URLSessionWebSocketTask strips the `Authorization` header on a WS upgrade
// (see `services/fleet-upgrade-auth.ts`), so this codebase has already had to
// move a credential into the query string once. The next time it happens, this
// fails.
//
// Measured before being written: 20 query parameters are read across the
// server, 4 are credential-shaped by name, and all 4 are already redacted. So
// this closes no live gap — it makes the roster's completeness a property that
// is checked rather than remembered. It is deliberately BEHAVIOURAL: it calls
// the real redactor with a marker value and asserts the marker is gone, rather
// than pinning the source text of the list, because a source-text pin guards
// the expression and not the behaviour.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { redactUrlQueryTokens } from '../../src/lib/redact-url.js';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** A value distinctive enough that finding it in the output is unambiguous. */
const MARKER = 'zq7marker4credential9value';

/**
 * Names that indicate the value is a credential rather than a filter or a
 * cursor. Deliberately broad — a false positive costs one allowlist entry with
 * a reason, a false negative costs a credential in a log file.
 */
const CREDENTIAL_SHAPED =
  /token|secret|password|passwd|credential|signature|(^|_)key$|(^|_)code$|(^|_)state$|(^|_)auth$/i;

/**
 * Query parameters whose name matches the pattern but which carry no secret.
 * Each needs a reason, and the shrink assertion below removes an entry the
 * moment the redactor starts covering it anyway.
 *
 * Empty today. It exists because the classifier is intentionally broad, and an
 * allowlist with no way to shrink rots into a permanent excuse.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Query parameters the server READS. Three declaration forms are in use:
 * the `Querystring: { … }` route generic, `req.query.<name>`, and destructuring
 * off `req.query`.
 *
 * One route types its querystring as `Querystring: Record<…>` and so accepts
 * names that cannot be enumerated statically. That is why the classifier below
 * is name-based rather than a fixed roster: a catch-all route can still only
 * leak through a key the redactor does not know.
 */
function queryParamsRead(): string[] {
  const found = new Set<string>();
  for (const file of tsFilesUnder(SERVER_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const block of src.matchAll(/Querystring:\s*\{([^}]*)\}/gs)) {
      for (const p of block[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g)) found.add(p[1]!);
    }
    for (const m of src.matchAll(/\b(?:req|request)\.query\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      found.add(m[1]!);
    }
    for (const m of src.matchAll(/\bconst\s*\{([^}]*)\}\s*=\s*(?:req|request)\.query\b/g)) {
      for (const p of m[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_]*)/g)) found.add(p[1]!);
    }
  }
  return [...found].sort();
}

const PARAMS = queryParamsRead();
const CREDENTIAL_PARAMS = PARAMS.filter(
  (p) => CREDENTIAL_SHAPED.test(p) && PUBLIC_BY_DESIGN[p] === undefined,
);

/** Does the real redactor remove this parameter's value? */
function isRedacted(param: string): boolean {
  return !redactUrlQueryTokens(`/v1/thing?${param}=${MARKER}`).includes(MARKER);
}

describe('every credential-bearing query parameter the server accepts is redacted', () => {
  it('CRITICAL the scan found the query surface and classified some of it as credential-bearing. An empty scan, or a classifier that matches nothing, would make the check below vacuously true — which is the exact failure this file exists to prevent elsewhere.', () => {
    expect(PARAMS.length, 'query parameters read across the server').toBeGreaterThan(10);
    expect(PARAMS, 'the WS-upgrade credential must survive the scan').toContain('ds_token');
    expect(CREDENTIAL_PARAMS.length, 'credential-shaped parameters').toBeGreaterThan(0);
  });

  it('CRITICAL every credential-shaped query parameter has its VALUE removed by the real redactor. A parameter added without a matching redaction entry keeps every existing redactor test green while the credential lands in nginx access logs and Sentry request.url.', () => {
    const leaking = CREDENTIAL_PARAMS.filter((p) => !isRedacted(p));
    expect(
      leaking.sort(),
      'query parameter(s) the server reads whose value survives redaction — add them to SENSITIVE_QUERY_KEYS in lib/redact-url.ts:',
    ).toEqual([]);
  });

  it('CRITICAL the redactor is selective, not a blanket eraser. Redacting everything would satisfy the check above while destroying the diagnostic value of every logged URL, so a benign parameter must come through intact.', () => {
    const url = redactUrlQueryTokens(`/v1/sessions?limit=25&status=active&cursor=${MARKER}`);
    expect(url, 'a non-credential parameter must not be redacted').toContain('limit=25');
    expect(url, 'an ordinary cursor value must survive').toContain(MARKER);
  });

  it('CRITICAL the public-by-design allowlist may only SHRINK — an entry the redactor now covers must leave it, and an entry naming a parameter the server no longer reads must go too. Without both directions the list becomes a permanent excuse rather than a debt.', () => {
    const nowRedacted = Object.keys(PUBLIC_BY_DESIGN).filter((p) => isRedacted(p));
    expect(
      nowRedacted.sort(),
      'these are redacted now — remove them from PUBLIC_BY_DESIGN so they stay checked:',
    ).toEqual([]);

    const stale = Object.keys(PUBLIC_BY_DESIGN).filter((p) => !PARAMS.includes(p));
    expect(stale.sort(), 'allowlist entries for parameters the server no longer reads:').toEqual(
      [],
    );
  });
});
