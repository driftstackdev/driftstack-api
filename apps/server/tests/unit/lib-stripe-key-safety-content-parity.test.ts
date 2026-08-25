// Drift guard for apps/server/src/lib/stripe-key-safety.ts. Pins the
// Q.2 fail-fast safety check that prevents sk_live_ from running
// before the BV KvK launch cutover on 2026-05-21.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/stripe-key-safety.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/stripe-key-safety content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Q.2 module-level framing pinned: 'fail-fast safety check that prevents a live-mode Stripe key from running before the BV KvK closure on 2026-05-21. If the operator accidentally drops a sk_live_ key into the prod env before the company entity is registered, the server refuses to boot rather than letting it silently start charging real cards.' — pinned so the Q.2 anchor + BV-KvK-closure + 2026-05-21 cutover + refuse-to-boot-not-silently-charge contract all stay documented (drift to softening would let prod accidentally accept sk_live_ before the company entity exists, opening real-card-charge liability)", () => {
    expect(body).toMatch(
      /\/\/ Q\.2 \(orchestrator handoff #3\) — fail-fast safety check that\s*\/\/ prevents a live-mode Stripe key from running before the BV KvK\s*\/\/ closure on 2026-05-21\. If the operator accidentally drops a\s*\/\/ sk_live_ key into the prod env before the company entity is\s*\/\/ registered, the server refuses to boot rather than letting it\s*\/\/ silently start charging real cards\./,
    );
  });

  it("Outside-BillingService framing pinned: 'The check intentionally lives outside BillingService so it fires during bootstrap regardless of whether billingService is fully wired — even a partial Stripe config (sk_live_ + nothing else) trips it before any HTTP routes register.' — pinned so the bootstrap-fires-before-routes + outside-BillingService rationale stays documented (drift to embedding inside BillingService would let partial-Stripe-config slip past the check)", () => {
    expect(body).toMatch(
      /\/\/ The check intentionally lives outside BillingService so it fires\s*\/\/ during bootstrap regardless of whether billingService is fully\s*\/\/ wired — even a partial Stripe config \(sk_live_ \+ nothing else\) trips it before any HTTP routes register\.|\/\/ The check intentionally lives outside BillingService so it fires\s*\/\/ during bootstrap regardless of whether billingService is fully\s*\/\/ wired — even a partial Stripe config \(sk_live_ \+ nothing else\)\s*\/\/ trips it before any HTTP routes register\./,
    );
  });

  it("Cutover-relaxation framing pinned: 'Cutover: on 2026-05-21 a follow-up commit relaxes this guard; once the founder has the entity in place + share the live keys, the bootstrap check passes any sk_ prefix.' — pinned so the 2026-05-21 cutover plan + relaxes-to-any-sk_-prefix contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Cutover: on 2026-05-21 a follow-up commit relaxes this guard;\s*\/\/ once the founder has the entity in place \+ share the live keys,\s*\/\/ the bootstrap check passes any sk_ prefix\./,
    );
  });

  it("STRIPE_LIVE_KEY_CUTOVER_UTC constant pinned: Date.UTC(2026, 4, 21) (month is 0-indexed; 4 = May). + 'Encoded as a UTC midnight timestamp so the check is timezone-stable — the host running the safety check could be in any TZ.' framing — pinned so the timezone-stable contract + the 2026-05-21 cutover date encoding stay documented (drift to a local-time encoding would let TZ-east-of-UTC hosts trip the check a day earlier than intended)", () => {
    expect(body).toMatch(
      /export const STRIPE_LIVE_KEY_CUTOVER_UTC = Date\.UTC\(2026, 4, 21\); \/\/ 2026-05-21/,
    );
    expect(body).toMatch(
      /\*\s+Encoded as a UTC midnight timestamp so the check is timezone-stable\s*\*\s+— the host running the safety check could be in any TZ\./,
    );
  });

  it('StripeKeySafetyArgs 2-field shape pinned: secretKey (string | undefined; STRIPE_SECRET_KEY) + now (Date, optional; injected for tests). + StripeKeySafetyResult 2-variant union (ok: true | ok: false + reason). Drift would break the bootstrap-call shape', () => {
    expect(body).toMatch(/export interface StripeKeySafetyArgs \{/);
    expect(body).toMatch(
      /\/\*\* The STRIPE_SECRET_KEY value as configured\. May be undefined\. \*\/\s*secretKey: string \| undefined;/,
    );
    expect(body).toMatch(
      /\/\*\* Wall-clock injected so tests can pin a known date\. Defaults to Date\.now\(\)\. \*\/\s*now\?: Date;/,
    );
    expect(body).toMatch(
      /export type StripeKeySafetyResult = \{ ok: true \} \| \{ ok: false; reason: string \};/,
    );
  });

  it('validateStripeKeyForLaunch 4-branch dispatch pinned: 1. undefined or empty key → ok=true (billing routes register as 503 stubs anyway) 2. non-sk_live_ prefix → ok=true (sk_test_ always acceptable) 3. sk_live_ + post-cutover → ok=true 4. sk_live_ + pre-cutover → ok=false with operator-facing reason. Drift to relaxing branch 4 would defeat the entire purpose of the guard', () => {
    expect(body).toMatch(
      /export function validateStripeKeyForLaunch\(args: StripeKeySafetyArgs\): StripeKeySafetyResult \{\s*const \{ secretKey \} = args;\s*if \(secretKey === undefined \|\| secretKey === ''\) \{\s*return \{ ok: true \};\s*\}/,
    );
    expect(body).toMatch(
      /if \(!secretKey\.startsWith\('sk_live_'\)\) \{\s*return \{ ok: true \};\s*\}\s*const now = \(args\.now \?\? new Date\(\)\)\.getTime\(\);\s*if \(now >= STRIPE_LIVE_KEY_CUTOVER_UTC\) \{\s*return \{ ok: true \};\s*\}/,
    );
  });

  it("Operator-facing reason string pinned: 'STRIPE_SECRET_KEY is sk_live_ but the BV KvK launch cutover (2026-05-21 UTC) has not been reached. Refusing to boot with a live-mode key before the entity is in place. Either switch to a sk_test_ key or wait for the cutover.' — pinned so the customer-facing error message + 2-resolution-paths (switch-to-sk_test_ or wait-for-cutover) commitment stays explicit (drift to a vaguer reason would leave operators confused about WHY the server refused to boot)", () => {
    expect(body).toMatch(
      /reason:\s*'STRIPE_SECRET_KEY is sk_live_ but the BV KvK launch cutover ' \+\s*'\(2026-05-21 UTC\) has not been reached\. Refusing to boot with a ' \+\s*'live-mode key before the entity is in place\. Either switch to a ' \+\s*'sk_test_ key or wait for the cutover\.',/,
    );
  });

  it("Passes-on-undefined framing pinned: 'undefined key (billing routes register as 503 stubs anyway)' — pinned so the undefined-is-OK + 503-stub semantics stay documented (drift to throwing on undefined would force every dev environment to set STRIPE_SECRET_KEY)", () => {
    expect(body).toMatch(/\*\s+- undefined key \(billing routes register as 503 stubs anyway\)/);
  });

  it("sk_test_-always-OK + post-cutover-any-sk_*-OK framing pinned: 'sk_test_ key (always acceptable, regardless of date)' + 'any sk_* key after the cutover' — pinned so the test-key-always-allowed + post-cutover-any-prefix-allowed contracts stay documented", () => {
    expect(body).toMatch(/\*\s+- sk_test_ key \(always acceptable, regardless of date\)/);
    expect(body).toMatch(/\*\s+- any sk_\* key after the cutover/);
  });
});
