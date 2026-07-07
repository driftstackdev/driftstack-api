// W914 — Email transport + V-057 Postmark + V-665 classifyEmailError
// cross-source invariant. Two-hundred-fortieth in the drift-guard
// series. Pins the transactional-email service contract:
//
//   V-057 — Postmark npm package as the underlying transport.
//
//   fire-and-forget — errors logged at warn-level but never thrown;
//   email is never on a request critical path. If Postmark is mis-
//   configured or down, the API stays up.
//
//   Templates owned in this file as plain TS objects (subject + text
//   body + HTML body). No Postmark "templates" feature dependency
//   (vendor-lock avoidance).
//
//   V-665 — classifyEmailError 7-category enum:
//     'pending-approval' | 'inactive-recipient' | 'account-inactive'
//     | 'invalid-request' | 'rate-limited' | 'transport' | 'unknown'.
//
//   Postmark code → category mapping (5 codes):
//     - 412 → 'pending-approval'
//     - 405 → 'inactive-recipient'
//     - 406 → 'account-inactive'
//     - 422 → 'invalid-request'
//     - 429 → 'rate-limited'
//
//   Transport-error names (7-set): ECONNRESET, ECONNREFUSED, ETIMEDOUT,
//     ENOTFOUND, EHOSTUNREACH, EAI_AGAIN, FetchError.
//
//   Message pattern fallback: 'pending approval' / 'not yet approved'
//     → 'pending-approval' (some wrapper libs return code as string).
//
//   Default Postmark messageStream = 'outbound'.
//
//   config === null → no-op stub service (isConfigured: false).
//
// stays in lockstep across apps/server/src/services/email.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyEmailError } from '../../src/services/email.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W914 Email transport + V-057 + V-665 cross-source invariant', () => {
  // ─── V-057 Postmark anchor + fire-and-forget framing ─────────

  it("CRITICAL apps/server/src/services/email.ts header pins V-057 — 'Wraps Postmark (postmark npm package, V-057)'. The V-057 anchor is the policy-provenance for choosing Postmark as outbound transport.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/Wraps Postmark \(`postmark` npm package, V-057\)/);
  });

  it("CRITICAL header pins 'All sends are fire-and-forget: errors are logged at warn-level but never thrown to the caller, because email is never on a request critical path'. The fire-and-forget contract is what keeps API uptime independent of Postmark availability.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/All sends are/);
    expect(p).toMatch(/fire-and-forget: errors are logged at warn-level but never thrown/);
    expect(p).toMatch(/email is never on a request critical path/);
  });

  it("CRITICAL header pins 'If Postmark is misconfigured or down, the API stays up; affected users get the email on the next attempt or out-of-band'. The graceful-degradation framing is the API-uptime guarantee.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/If Postmark is misconfigured or down, the API stays up/);
    expect(p).toMatch(/affected/);
    expect(p).toMatch(/users get the email on the next attempt or out-of-band/);
  });

  // ─── Inline templates rationale ──────────────────────────────

  it("CRITICAL header pins 'No Postmark templates feature dependency — that ties us to the vendor harder than necessary, and the templates are simple enough to keep inline'. The inline-templates rationale is the vendor-lock avoidance policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/No Postmark "templates" feature dependency/);
    expect(p).toMatch(/that ties us to the vendor harder than necessary/);
    expect(p).toMatch(/templates are simple enough to keep inline/);
  });

  // ─── V-665 EmailErrorCategory 7-value enum ───────────────────

  it("CRITICAL V-665 EmailErrorCategory has 7 values — 'pending-approval' | 'inactive-recipient' | 'account-inactive' | 'invalid-request' | 'rate-limited' | 'transport' | 'unknown'. The 7-value categorization lets dashboards / alerts distinguish pending-approval (expected) from genuine ops failures.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/export type EmailErrorCategory =/);
    expect(p).toMatch(/\| 'pending-approval'/);
    expect(p).toMatch(/\| 'inactive-recipient'/);
    expect(p).toMatch(/\| 'account-inactive'/);
    expect(p).toMatch(/\| 'invalid-request'/);
    expect(p).toMatch(/\| 'rate-limited'/);
    expect(p).toMatch(/\| 'transport'/);
    expect(p).toMatch(/\| 'unknown';/);
  });

  it("CRITICAL V-665 anchor + 'classifying email-send failure categories' header. The V-665 anchor is what dashboards / alerts read to suppress pre-approval errors.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/V-665 — classifying email-send failure categories/);
  });

  // ─── Postmark code → category (5 codes) ──────────────────────

  it('CRITICAL header pins 5 Postmark codes — 412 (pending-approval), 405 (inactive-recipient), 406 (account-inactive), 422 (invalid-request), 429 (rate-limited). The 5-code mapping is the Postmark API contract reference.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/412 — Account pending approval/);
    expect(p).toMatch(/405 — Recipient inactive/);
    expect(p).toMatch(/406 — Account inactive/);
    expect(p).toMatch(/422 — Invalid email request/);
    expect(p).toMatch(/429 — Rate limit/);
  });

  it('CRITICAL classifyEmailError({ code: 412 }) → category=pending-approval, postmarkCode=412. The 412 mapping is the most operationally-important — it lets dashboards suppress the expected pre-approval warning storm.', () => {
    expect(classifyEmailError({ code: 412 })).toEqual({
      category: 'pending-approval',
      postmarkCode: 412,
    });
  });

  it('CRITICAL classifyEmailError({ code: 405 }) → inactive-recipient, code: 406 → account-inactive, code: 422 → invalid-request, code: 429 → rate-limited. The 4 non-pending codes map distinct categories.', () => {
    expect(classifyEmailError({ code: 405 }).category).toBe('inactive-recipient');
    expect(classifyEmailError({ code: 406 }).category).toBe('account-inactive');
    expect(classifyEmailError({ code: 422 }).category).toBe('invalid-request');
    expect(classifyEmailError({ code: 429 }).category).toBe('rate-limited');
  });

  // ─── Transport-error names (7-set) ───────────────────────────

  it('CRITICAL transportNames Set has 7 entries — ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH, EAI_AGAIN, FetchError. The 7-name set categorizes connection-level failures distinct from Postmark API errors.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/'ECONNRESET'/);
    expect(p).toMatch(/'ECONNREFUSED'/);
    expect(p).toMatch(/'ETIMEDOUT'/);
    expect(p).toMatch(/'ENOTFOUND'/);
    expect(p).toMatch(/'EHOSTUNREACH'/);
    expect(p).toMatch(/'EAI_AGAIN'/);
    expect(p).toMatch(/'FetchError'/);
  });

  it('CRITICAL classifyEmailError({ name: "ECONNRESET" }) → category=transport, postmarkCode=null. The transport category surfaces socket-level failures distinct from Postmark API errors.', () => {
    expect(classifyEmailError({ name: 'ECONNRESET' })).toEqual({
      category: 'transport',
      postmarkCode: null,
    });
    expect(classifyEmailError({ name: 'ETIMEDOUT' }).category).toBe('transport');
    expect(classifyEmailError({ name: 'FetchError' }).category).toBe('transport');
  });

  // ─── Message-pattern fallback for pending-approval ───────────

  it('CRITICAL message-pattern fallback — \'message.includes("pending approval") || message.includes("not yet approved") → pending-approval\'. The string-fallback handles wrapper libs that set code as string instead of number.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/'pending approval'/);
    expect(p).toMatch(/'not yet approved'/);
    expect(p).toMatch(
      /if \(message\.includes\('pending approval'\) \|\| message\.includes\('not yet approved'\)\)/,
    );
  });

  it("CRITICAL classifyEmailError({ message: 'Account is pending approval' }) → pending-approval. The case-insensitive (toLowerCase) message-pattern catches Postmark text framings.", () => {
    expect(classifyEmailError({ message: 'Account is pending approval' }).category).toBe(
      'pending-approval',
    );
    expect(classifyEmailError({ message: 'Sender not yet approved by Postmark' }).category).toBe(
      'pending-approval',
    );
  });

  it('CRITICAL classifyEmailError(null) → unknown, postmarkCode=null + classifyEmailError(undefined) → unknown. The 2 null-input guards prevent NPE on early-failure paths.', () => {
    expect(classifyEmailError(null)).toEqual({ category: 'unknown', postmarkCode: null });
    expect(classifyEmailError(undefined)).toEqual({ category: 'unknown', postmarkCode: null });
  });

  // ─── Default messageStream 'outbound' ────────────────────────

  it("CRITICAL createEmailService default messageStream = 'outbound'. The 'outbound' default routes transactional sends to the standard Postmark stream — 'broadcast' / 'inbound' streams have different deliverability + reply-handling semantics.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/messageStream = 'outbound'/);
    expect(p).toMatch(/Postmark message stream\. Default `outbound`/);
  });

  // ─── config === null → no-op stub ────────────────────────────

  it("CRITICAL config === null returns no-op stub service — 'Postmark not configured — email sends will be no-ops. Set POSTMARK_API_TOKEN/FROM/REPLY_TO to enable'. The no-op stub lets local-dev + test bootstrap without Postmark credentials.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(
      /Postmark not configured — email sends will be no-ops\. Set POSTMARK_API_TOKEN\/FROM\/REPLY_TO to enable/,
    );
    expect(p).toMatch(/isConfigured: false,/);
  });

  it('CRITICAL config-present branch returns isConfigured: true + real Postmark client. The 2-branch factory distinguishes dev / test (no-op) from prod (real Postmark) without forcing per-call null-checks at the call sites.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/isConfigured: true,/);
    expect(p).toMatch(/const postmark: PostmarkSendApi = client \?\? new PostmarkClient/);
  });

  // ─── send() try-catch + V-665 categorise + swallow framing ───

  it("CRITICAL send() wraps postmark.sendEmail in try-catch — 'V-665 — categorise the failure so dashboards / alerts can distinguish Postmark account still pending approval (the expected pre-approval state — submitted 2026-05-09, see status.md) from genuine transport / recipient / config failures that need ops attention'. The V-665 framing is the dashboard signal-policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/V-665 — categorise the failure/);
    expect(p).toMatch(/distinguish "Postmark account still pending approval"/);
    expect(p).toMatch(/expected pre-approval state — submitted 2026-05-09/);
    expect(p).toMatch(
      /from genuine transport \/ recipient \/ config\s*\n\s+\/\/ failures that need ops attention/,
    );
  });

  it("CRITICAL send() catch logs at warn-level + deliberately swallows — 'Deliberately swallow — email is never on a request critical path'. The deliberate-swallow framing reinforces the fire-and-forget contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(/Deliberately swallow — email is never on a request critical path/);
  });

  // ─── EmailService methods (sample 4 of the 18) ───────────────

  it('CRITICAL EmailService interface declares the 4-core methods — sendSignupVerification + sendPasswordReset + sendBillingReceipt + sendBillingFailure. The core methods are present on both the no-op stub AND the real impl, so call sites can rely on the same shape regardless of config. (S44 2026-07-07 founder-approved trim deleted sendSubscriptionCancellation + sendSupportAck — zero callers; asserted GONE.)', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(p).toMatch(
      /sendSignupVerification\(args: \{ to: string; link: string; expiresAt: Date \}\): Promise<void>/,
    );
    expect(p).toMatch(
      /sendPasswordReset\(args: \{ to: string; link: string; expiresAt: Date \}\): Promise<void>/,
    );
    expect(p).toMatch(/sendBillingReceipt\(args: \{/);
    expect(p).toMatch(/sendBillingFailure\(args: \{/);
    expect(p).not.toMatch(/sendSubscriptionCancellation\(/);
    expect(p).not.toMatch(/sendSupportAck\(/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/email-transport-classify-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
