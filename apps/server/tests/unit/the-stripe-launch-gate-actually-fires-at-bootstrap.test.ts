// The live-key gate's own comment says it fires during bootstrap. This asserts
// that it does.
//
// `lib/stripe-key-safety.ts` is thoroughly covered: eleven behavioural arms over
// `validateStripeKeyForLaunch`, and a content-parity guard pinning its framing —
// including the sentence "The check intentionally lives outside BillingService so
// it fires during bootstrap regardless of whether billingService is constructed".
//
// ⛔ Nothing pinned the half that makes that sentence true. The function only
// RETURNS `{ ok: false, reason }`; refusing to boot is the caller's job, and the
// file says so out loud: "Caller is responsible for failing the bootstrap when
// ok=false". Measured by mutation rather than by reading: replacing the throw in
// `createProductionDeps` with a no-op — type-clean, 0 tsc errors — left all five
// test files that invoke the bootstrap entry points green, 33 of 33.
//
// So the claim was guarded and the behaviour was not. A prose pin asserting a
// safety property, over a file that cannot enforce it alone, is the "statement is
// decoration" shape that `every-boolean-tier-feature-is-enforced` names in its own
// header — here with a commercial consequence: an `sk_live_` key before the
// cutover boots a server that can take real money in a pre-launch environment.
//
// Source-reading rather than behavioural because the check lives inside
// `createProductionDeps`, which needs a database, Redis and a full config to
// construct; the wiring is what drifts, and the wiring is what this pins.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const SAFETY = resolve(REPO_ROOT, 'apps/server/src/lib/stripe-key-safety.ts');

describe('the stripe launch gate actually fires at bootstrap', () => {
  const bootstrap = readFileSync(BOOTSTRAP, 'utf8');

  it('CRITICAL the safety module still states that the caller must fail the bootstrap. If this sentence goes, the arms below are pinning a contract nobody claims any more, and should be re-read rather than kept.', () => {
    expect(readFileSync(SAFETY, 'utf8')).toMatch(
      /Caller is responsible for failing the bootstrap when ok=false/,
    );
  });

  it('CRITICAL bootstrap CALLS the gate. The function is exhaustively unit-tested and none of that matters if nothing invokes it — a safety check nobody runs is the most expensive kind of green.', () => {
    expect(bootstrap).toMatch(/validateStripeKeyForLaunch\(/);
  });

  it('CRITICAL bootstrap THROWS on a failed gate rather than logging or continuing. Returning ok=false is all the module can do; refusing to boot is the caller’s half, and an sk_live_ key before the cutover otherwise starts a server that can take real money pre-launch.', () => {
    expect(bootstrap).toMatch(
      /if\s*\(\s*!\s*\w*[Ss]tripeKeySafety\w*\.ok\s*\)\s*\{\s*throw new Error\(/,
    );
  });

  it('CRITICAL the thrown message is the module’s own operator-facing reason, not a rewritten one. The reason string is pinned next door and is what tells an operator which key and which date; re-wording it here would strand that pin.', () => {
    expect(bootstrap).toMatch(/throw new Error\(\s*\w*[Ss]tripeKeySafety\w*\.reason\s*\)/);
  });
});
