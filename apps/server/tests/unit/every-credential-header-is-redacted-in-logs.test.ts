// Every request header the server treats as a credential is scrubbed from logs.
//
// Pino's `redact.paths` is keyed on exact paths, so a header is scrubbed only if
// someone remembered to name it. That is fine while the list keeps up and silent
// when it does not: nothing fails, the header simply appears in a log line the
// first time any code path logs `req.headers`.
//
// `x-nowpayments-sig` was in exactly that state. `stripe-signature` sits in the
// same block under the comment "Auth headers", and the NOWPayments equivalent —
// the HMAC-SHA512 of the IPN payload — was absent. Not a decision, an omission:
// treating one provider's webhook signature as sensitive while logging another's
// is not a position anyone would defend. A logged signature alongside the logged
// payload is a replayable pair.
//
// The two headers next to it in that block carry explicit defence-in-depth
// reasoning — the BYOK Anthropic key and the GUI control key are scrubbed "even
// though the route never logs req.headers explicitly", against "a future
// refactor that adds a request-trace log". That reasoning applies to every entry
// here, which is the argument for deriving the set rather than appending to it
// by hand.
//
// CLASSIFICATION IS EXPLICIT, both ways. Every header the server reads is either
// a credential that must be redacted, or is named as carrying nothing secret. A
// keyword regex over header names would be a blocklist — it would silently pass
// the one header nobody thought to name, which is exactly the failure mode. The
// non-secret list is short and each entry is a claim someone can check:
//
// WHAT THIS CANNOT SEE — V-1515 closed the gap this paragraph used to describe,
// and found a second one it did not.
//
// The declared gap: headers reached through a constant were invisible, so
// `x-driftstack-account` (read as `EFFECTIVE_ACCOUNT_HEADER`) never reached the
// classification. The old note argued that resolving identifiers means guessing.
// It does not have to: an identifier is followed only to a `const NAME = 'literal'`
// in this same tree, and one that resolves to nothing is REPORTED rather than
// assumed harmless. That is a narrower rule than the guessing it rejected.
//
// The undeclared one, which mattered more: the scan matched `headers['x-name']`
// and not `headers.name`, so `authorization` and `cookie` — the two headline
// credentials — were never discovered. Both sit in the credential set because
// someone put them there by hand, so nothing was ever logged in the clear. But
// the arm below claims to classify every header the server reads, and it had
// never once seen the two most obvious ones. A hand-written list agreeing with a
// scan that cannot reach the same headers is not corroboration.
//
// Now three spellings, and the floor in the first arm is the measured total, so a
// scan that stops reading one of them fails instead of reporting a clean set.
//
// What remains outside: a header name built at runtime rather than declared as a
// constant. Nothing does that today; if something starts, it is invisible again.
//
// This does not assert that logging happens — it asserts that IF it happens the
// value is scrubbed, which is the only property a static check can hold.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const LOGGER = resolve(SERVER_SRC, 'lib', 'logger.ts');

/** Headers that carry a secret, a signature, or a bearer value. MEASURED at 7. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'stripe-signature',
  'x-nowpayments-sig',
  'x-byok-anthropic-api-key',
  'x-driftstack-gui-control-key',
]);

/**
 * Headers the server reads by literal name that carry nothing secret.
 *
 * MEASURED at 8. Each is a claim someone can check: the four `cf-*` are
 * Cloudflare's geo hints, `last-event-id` is the SSE resume cursor,
 * `x-request-id` is a correlation id, `user-agent` is self-declared, and
 * `idempotency-key` is a client-chosen identifier scoped per account and
 * useless without that account's own credentials.
 */
const NON_CREDENTIAL_HEADERS = new Set([
  'cf-ipcity',
  'cf-ipcountry',
  'cf-iplatitude',
  'cf-iplongitude',
  'cf-region',
  'cf-timezone',
  'idempotency-key',
  'last-event-id',
  'user-agent',
  'x-request-id',
  // V-1515 — four the scan could not see until it read the dot and constant
  // spellings. Each is a claim someone can check, on the same terms as the rest:
  //
  //   accept                    content negotiation; the agent-message route
  //                             reads it to choose the SSE representation.
  //   origin                    the browser's own origin, echoed back through
  //                             sseCorsHeaders. Attacker-supplied, never trusted
  //                             as authority, and secret from nobody.
  //   x-driftstack-account      an account id (`acc_<uuid>`) naming who a staff
  //                             caller is acting AS. It authorizes nothing on its
  //                             own — `effective-account-header-authz-invariant`
  //                             is the guard that the authority comes from the
  //                             bearer token beside it.
  //   x-driftstack-mac-node-id  a fleet node id. The node's actual credential is
  //                             the short-lived bearer JWT that accompanies it,
  //                             which is `authorization` and redacted.
  'accept',
  'origin',
  'x-driftstack-account',
  'x-driftstack-mac-node-id',
]);

/**
 * Every request header the server source reads, comments excluded.
 *
 * V-1515 — three spellings, because two of them used to be invisible.
 *
 *   headers['x-name']   the original scan
 *   headers.name        NEVER declared as a gap, and it hid `authorization` and
 *                       `cookie` — the two headline credentials. Both are in the
 *                       credential set by hand, so nothing leaked; the guard's
 *                       claim to classify "every header the server reads" simply
 *                       did not reach them.
 *   headers[CONST]      the gap the header DID declare. Resolved narrowly: an
 *                       identifier is followed only to a `const NAME = 'literal'`
 *                       in this same source tree. That is not the guessing the
 *                       old note rejected — an unresolvable identifier stays
 *                       unresolved and is reported by the arm below rather than
 *                       assumed harmless.
 */
function headerNameConstants(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(
        /^(?:export\s+)?const ([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9-]+)'/gm,
      )) {
        out.set(m[1]!, m[2]!);
      }
    }
  };
  walk(SERVER_SRC);
  return out;
}

/** Identifiers used as `headers[IDENT]` that no constant in the tree resolves. */
function unresolvedHeaderConstants(): string[] {
  const known = headerNameConstants();
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
          continue;
        for (const m of trimmed.matchAll(/headers\[\s*([A-Z][A-Z0-9_]*)\s*\]/g)) {
          if (!known.has(m[1]!)) out.add(m[1]!);
        }
      }
    }
  };
  walk(SERVER_SRC);
  return [...out].sort();
}

function headersRead(): Set<string> {
  const constants = headerNameConstants();
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        for (const m of trimmed.matchAll(/headers\[\s*['"]([a-z0-9-]+)['"]\s*\]/g)) {
          out.add(m[1]!);
        }
        // Dot form. `(?!\()` keeps Headers/Map methods (`headers.get(...)`)
        // out — a method call is not a header name.
        for (const m of trimmed.matchAll(/\bheaders\.([a-z][a-z0-9-]*)\b(?!\s*\()/g)) {
          out.add(m[1]!);
        }
        for (const m of trimmed.matchAll(/headers\[\s*([A-Z][A-Z0-9_]*)\s*\]/g)) {
          const resolved = constants.get(m[1]!);
          if (resolved !== undefined) out.add(resolved);
        }
      }
    }
  };
  walk(SERVER_SRC);
  return out;
}

/**
 * Header names in the logger's pino redact paths.
 *
 * Both spellings count: `req.headers.authorization` and
 * `req.headers["stripe-signature"]`. A first version matched only the bracket
 * form and reported `authorization` and `cookie` — the two most obvious
 * credentials in the file — as unredacted.
 */
function redactedHeaders(): Set<string> {
  const src = readFileSync(LOGGER, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:req|res)\.headers(?:\.([a-z-]+)|\["([a-z0-9-]+)"\])/g)) {
    out.add((m[1] ?? m[2])!);
  }
  return out;
}

describe('every credential-bearing header is redacted in logs', () => {
  it('CRITICAL both sides were read. Every assertion reports an absence, and an absence against an empty redaction list is every header — a reader that matched nothing would report the whole set unredacted, or with the classification absorbing it, report everything fine.', () => {
    // MEASURED: 7 redaction paths naming headers; 19 headers read across the
    // three spellings (13 by literal, plus the dot and constant forms V-1515
    // added). The floor is the measured value so a scan that silently stops
    // reading one of the spellings fails here rather than reporting a clean set.
    expect(
      redactedHeaders().size,
      'header names parsed from the redact paths',
    ).toBeGreaterThanOrEqual(7);
    expect(
      headersRead().size,
      'headers read by the server source, all three spellings',
    ).toBeGreaterThanOrEqual(19);

    // V-1515 — an identifier used as `headers[IDENT]` that no constant resolves
    // is neither classified nor visible. Reported rather than assumed harmless.
    expect(
      unresolvedHeaderConstants(),
      'header constant(s) this scan could not resolve to a literal:',
    ).toEqual([]);

    // On a pair whose answer is not in doubt: the two providers' webhook
    // signature headers are both scrubbed.
    expect(redactedHeaders().has('stripe-signature'), 'the Stripe signature is redacted').toBe(
      true,
    );
    expect(redactedHeaders().has('x-nowpayments-sig'), 'and the NOWPayments one').toBe(true);
  });

  it('CRITICAL every credential header appears in the redact paths. Pino scrubs by exact path, so a header nobody named is logged in full the first time any code path logs req.headers — silently, with nothing failing.', () => {
    const redacted = redactedHeaders();
    const missing = [...CREDENTIAL_HEADERS].filter((h) => !redacted.has(h)).sort();
    expect(missing, 'credential header(s) absent from the logger redact paths:').toEqual([]);
  });

  it('CRITICAL every header the server reads is classified. A keyword regex over names would be a blocklist and would pass the one header nobody thought of, so a new header has to be called a credential or explicitly called harmless.', () => {
    const unclassified = [...headersRead()]
      .filter((h) => !CREDENTIAL_HEADERS.has(h) && !NON_CREDENTIAL_HEADERS.has(h))
      .sort();
    expect(
      unclassified,
      'header(s) read by the server and classified as neither credential nor harmless:',
    ).toEqual([]);
  });

  it('CRITICAL the harmless list is not a dumping ground. An entry for a header nothing reads any more is stale, and a list that accumulates closed items is how a genuinely wrong entry stops being noticed. Only the harmless list is checked this way — a credential can legitimately be redacted without being read by literal name anywhere.', () => {
    const read = headersRead();
    const stale = [...NON_CREDENTIAL_HEADERS].filter((h) => !read.has(h)).sort();
    expect(stale, 'header(s) declared harmless that the server no longer reads:').toEqual([]);
  });
});
