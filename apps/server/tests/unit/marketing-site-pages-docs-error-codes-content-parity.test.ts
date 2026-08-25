// W510.C — drift guard for apps/marketing-site/src/pages/docs/error-codes.astro.
// V-688 / W203 error-codes developer reference. Drift here either
// re-introduces the fictional { error: { code, message } } envelope
// W203 removed (would mislead clients) or drops a problem-type URI
// from the ERRORS table (would orphan that error from the public
// reference).
//
//   • V-688 / W203 doc-comment framing + RFC 7807 flat-shape commitment.
//   • ERRORS table 23+ problem-type URIs with stable slugs.
//   • Selection of high-priority error types: validation-failed +
//     unauthorized + invalid-key + revoked-key + email-not-verified +
//     forbidden + mfa-step-up-required + legal-acceptance-required +
//     not-found + conflict + concurrency-limit + tier-limit +
//     rate-limited + session-destroyed + driver-error.
//   • https://errors.driftstack.dev/<slug> URI format.
//   • Defensive 'treat unknown types as internal' commitment.
//   • OAuth error mapping: invalid_client → unauthorized,
//     invalid_request → bad-request.
//   • X-Request-Id correlation for support.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/error-codes.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W510.C apps/marketing-site/src/pages/docs/error-codes.astro content parity', () => {
  const body = read(LIB);

  it('V-688 / W203 framing pinned: \'error-codes developer reference. Lets developers grep logs for a problem-type URI + jump straight to "what does this mean / what should I do."\' + \'W203 rewrote this doc to match reality: every Driftstack error response is RFC 7807 (application/problem+json) with a flat shape — type URI + title + status + detail + extension keys at the top level. The previous version of this page advertised a fictional { "error": { "code": ..., "message": ... } } envelope and a code field that the server doesn\'t emit; clients dispatching on error.code would have hit undefined on every error path.\' — pinned so the V-688 + W203 anchors + the explicit-no-error.code commitment + the flat-RFC-7807 framing all survive (drift to re-introducing { error: {...} } would mislead clients into a non-existent dispatch path)', () => {
    expect(body).toMatch(
      /\/\/ V-688 \/ W203 — error-codes developer reference\. Lets developers\s*\/\/ grep logs for a problem-type URI \+ jump straight to "what does this\s*\/\/ mean \/ what should I do\."/,
    );
    expect(body).toMatch(
      /\/\/ W203 rewrote this doc to match reality: every Driftstack error\s*\/\/ response is RFC 7807 \(`application\/problem\+json`\) with a flat\s*\/\/ shape — `type` URI \+ `title` \+ `status` \+ `detail` \+ extension\s*\/\/ keys at the top level\./,
    );
    expect(body).toMatch(
      /\/\/ and a `code` field that the server doesn't emit; clients dispatching\s*\/\/ on `error\.code` would have hit `undefined` on every error path\./,
    );
  });

  it("Lead-paragraph dispatch-on-type framing pinned: 'Every error response from Driftstack is RFC 7807 application/problem+json. The stable identifier is the type URI; dispatch your client logic on type, not on the HTTP status or the human-readable title / detail.' — pinned so the 'dispatch on type, not on status/title/detail' commitment survives (drift to dropping the explicit guidance would let clients dispatch on the wrong field and miss the type-stability guarantee)", () => {
    expect(body).toMatch(
      /Every error response from Driftstack is RFC 7807\s*<code>application\/problem\+json<\/code>\. The stable identifier is\s*the <code>type<\/code> URI; dispatch your client logic on\s*<code>type<\/code>, not on the HTTP status or the human-readable\s*<code>title<\/code> \/ <code>detail<\/code>\./,
    );
  });

  it('Sample 429 response shape pinned: HTTP/1.1 429 + Retry-After: 12 + application/problem+json + rate-limited type URI + retry_after_seconds: 12 — pinned so the sample-response 5-element format stays consistent (drift to dropping the explicit retry_after_seconds extension would let clients miss the parallel JSON-extension/header signal)', () => {
    expect(body).toMatch(/HTTP\/1\.1 429 Too Many Requests/);
    expect(body).toMatch(/Retry-After: 12/);
    expect(body).toMatch(/Content-Type: application\/problem\+json/);
    expect(body).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(body).toMatch(/"retry_after_seconds": 12/);
  });

  it("Required-vs-optional field 5-list pinned: required type + title + status + optional detail + optional instance + 'problem-specific extensions (flat keys on the top-level, per RFC 7807 §3.2)' — pinned so the 5-field RFC-7807 + flat-extensions commitment survive (drift to nesting extensions would create marketing↔server divergence; drift to dropping the §3.2 anchor would weaken the RFC-citation specificity)", () => {
    expect(body).toMatch(
      /Required fields: <code>type<\/code>, <code>title<\/code>,\s*<code>status<\/code>\. Optional: <code>detail<\/code> \(human\s*message\), <code>instance<\/code> \(request id when present\), and\s*problem-specific extensions \(flat keys on the top-level, per RFC\s*7807 §3\.2\)\./,
    );
  });

  it("Same-status-multiple-types framing pinned: 'Always check type, not the HTTP status alone — the same status can correspond to multiple types (e.g. 429 covers both rate-limited and concurrency-limit; 401 covers six distinct types).' — pinned so the explicit warning + the 429-multi-type + 401-six-types examples all survive (drift to dropping the multi-type warning would let clients dispatch incorrectly on status alone)", () => {
    expect(body).toMatch(
      /Always check <code>type<\/code>, not the HTTP status\s*alone — the same status can correspond to multiple types\s*\(e\.g\. 429 covers both <code>rate-limited<\/code> and\s*<code>concurrency-limit<\/code>; 401 covers six distinct types\)\./,
    );
  });

  it('High-priority problem-type URIs (selection): validation-failed + unauthorized + invalid-key + revoked-key + email-not-verified + forbidden + mfa-step-up-required + legal-acceptance-required + not-found + conflict + concurrency-limit + tier-limit + rate-limited + session-destroyed + driver-error — pinned so 15 of the load-bearing type URIs stay in the ERRORS table (drift to dropping any would orphan that error from the public reference)', () => {
    expect(body).toMatch(/uri: 'validation-failed'/);
    expect(body).toMatch(/uri: 'unauthorized'/);
    expect(body).toMatch(/uri: 'invalid-key'/);
    expect(body).toMatch(/uri: 'revoked-key'/);
    expect(body).toMatch(/uri: 'email-not-verified'/);
    expect(body).toMatch(/uri: 'forbidden'/);
    expect(body).toMatch(/uri: 'mfa-step-up-required'/);
    expect(body).toMatch(/uri: 'legal-acceptance-required'/);
    expect(body).toMatch(/uri: 'not-found'/);
    expect(body).toMatch(/uri: 'conflict'/);
    expect(body).toMatch(/uri: 'concurrency-limit'/);
    expect(body).toMatch(/uri: 'tier-limit'/);
    expect(body).toMatch(/uri: 'rate-limited'/);
    expect(body).toMatch(/uri: 'session-destroyed'/);
    expect(body).toMatch(/uri: 'driver-error'/);
  });

  it("invalid-credentials + not-found no-enumeration framing pinned: 'invalid-credentials' → 'Login failed (wrong password) OR account does not exist — both surface the same shape on purpose (no enumeration).' + 'not-found' → 'Resource id does not exist OR you do not have access (both surface as 404; no enumeration).' — pinned so the 2-state no-enumeration framing (login + resource access) survives (drift to softening either would re-introduce the user-enumeration leak; this is the same pattern as the V-295c3 status-subscriptions design)", () => {
    expect(body).toMatch(
      /Login failed \(wrong password\) OR account does not exist — both surface the same shape on purpose \(no enumeration\)\./,
    );
    expect(body).toMatch(
      /Resource id does not exist OR you do not have access \(both surface as 404; no enumeration\)\./,
    );
  });

  it('describes terminal driver and deployment-capability failures without rollout language or unsafe automatic-retry advice', () => {
    expect(body).toContain(
      "when: 'The active browser runtime returned a structured failure.', action: 'Do not automatically retry; inspect `detail` and include X-Request-Id when contacting support.'",
    );
    expect(body).toContain(
      "when: 'The selected operation is not supported by the active browser runtime.', action: 'Not retryable; choose a supported operation or contact support with X-Request-Id.'",
    );
    expect(body).toContain(
      "when: 'A capability required by this operation is disabled or unavailable on the deployment.', action: 'Not retryable until the capability is available; contact the deployment operator with X-Request-Id.'",
    );
    expect(body).toContain("when: 'The agent-session turn has no usable Anthropic credential.'");
    expect(body).not.toMatch(
      /hasn't been wired|hasn’t been wired|documented path lands|operator must wire|BYOK-for-v1\.0|Often retryable/i,
    );
  });

  it("https://errors.driftstack.dev/<slug> URI-format + slug-stability commitment pinned: 'The full URI is https://errors.driftstack.dev/<slug> where <slug> is the value in the first column. Slugs are stable; they will not be renamed without a deprecation window.' — pinned so the canonical URI format + the slug-stability guarantee survive (drift to renaming a slug without deprecation would break customer log-grep pipelines)", () => {
    expect(body).toMatch(
      /The full URI is <code>https:\/\/errors\.driftstack\.dev\/&lt;slug&gt;<\/code>\s*where <code>&lt;slug&gt;<\/code> is the value in the first column\.\s*Slugs are stable; they will not be renamed without a deprecation\s*window\./,
    );
  });

  it("Defensive 'treat unknown types as internal' framing + stability guarantee pinned: 'The type URI slugs listed above are part of the API contract — they will not be renamed or removed without a deprecation window. New types may be added; defensive clients should treat unknown types as internal (i.e. retry with backoff and surface detail to the operator).' — pinned so the contract-stability + defensive-unknown-handling commitments survive (drift to dropping the 'unknown as internal' guidance would let clients crash on new error types)", () => {
    expect(body).toMatch(
      /The <code>type<\/code> URI slugs listed above are part of the API\s*contract — they will not be renamed or removed without a\s*deprecation window\. New types may be added; defensive clients\s*should treat unknown types as <code>internal<\/code>\s*\(i\.e\. retry with backoff and surface <code>detail<\/code> to the\s*operator\)\./,
    );
  });

  it("OAuth token-endpoint error mapping pinned: 'invalid_client / unauthorized_client → type is unauthorized.' + 'invalid_request / invalid_scope / invalid_grant / access_denied → type is bad-request.' — pinned so the OAuth-error-to-RFC-7807-type mapping survives (drift to a different mapping would create marketing↔OAuth-server divergence)", () => {
    expect(body).toMatch(
      /<li><code>invalid_client<\/code> \/ <code>unauthorized_client<\/code> → <code>type<\/code> is <code>unauthorized<\/code>\.<\/li>/,
    );
    expect(body).toMatch(
      /<li><code>invalid_request<\/code> \/ <code>invalid_scope<\/code> \/ <code>invalid_grant<\/code> \/ <code>access_denied<\/code> → <code>type<\/code> is <code>bad-request<\/code>\.<\/li>/,
    );
  });

  it("X-Request-Id support-correlation framing pinned: 'Include the X-Request-Id header from the response — every Driftstack response carries one, and we use it to find the corresponding server logs.' — pinned so the always-on X-Request-Id + log-correlation commitment survives (drift to dropping the always-set guarantee would let customers question whether they can include it; consistent with /docs/api-versioning framing)", () => {
    expect(body).toMatch(
      /Include the <code>X-Request-Id<\/code> header from the response —\s*every Driftstack response carries one, and we use it to find the\s*corresponding server logs\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
