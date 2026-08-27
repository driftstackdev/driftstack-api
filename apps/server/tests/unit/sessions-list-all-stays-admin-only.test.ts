// V-1826 — `SessionsService.listAll` is an all-tenant listing whose only inner
// gate had no behavioural witness.
//
// `sessions-repo.listAllSessions` takes an OPTIONAL `accountId`: supply one and
// the query filters, omit it and the listing spans every tenant. That is correct
// — it is a staff surface — and `throwIfMissingScope(ctx, 'driftstack_internal_
// admin')` in the service wrapper is what keeps it staff-only.
//
// MEASURED before writing this (V-1824/V-1825): removing that check left the FULL
// suite green except two arms of `the-server-source-type-checks`, which fire only
// because the now-unused `ctx` parameter trips TS6133. A lint objection is not a
// guard — a refactor that drops the check while still referencing `ctx` passes it.
//
// Both siblings in the same shape already have a witness: `api-keys.listAll` via
// the `unscoped-cursor-listings-stay-admin-only` roster, and
// `rate-limit-overrides.listAll` via a behavioural refusal arm. This closes an
// inconsistency, not an absence, and copies the better of the two instruments.
//
// The route gates on the same scope (`admin-sessions.ts:70,104` —
// `requireScope('driftstack_internal_admin')`), so this was never a live exposure
// — it is the second line that nothing verified.
//
// ⛔ CORRECTED 2026-08-26 (V-1855): this originally credited
// `route-auth-coverage-invariant` for the route layer, and that guard is the wrong
// one to cite. It derives every route file and asserts each route HAS structural
// caller authority — presence of a gate, not WHICH scope — so it would stay green
// if this route's `driftstack_internal_admin` became `account_owner`. The guard
// that actually pins the specific scope is `admin-scope-refusal-coverage`, whose
// `EXPECTED_STAFF_ROUTES` lists `GET /v1/admin/sessions` and drives a real refusal
// for a non-staff caller. The conclusion above was right and the reason was not.

import { describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import type { Driver } from '../../src/drivers/types.js';
import type { AccountContext } from '../../src/services/auth.js';

function ctxWithScopes(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: { id: 'acc_admin' },
    apiKey: { id: 'key_admin', scopes },
  } as unknown as AccountContext;
}

function makeService(): SessionsService {
  const repo = new InMemorySessionsRepo();
  // `listAll` refuses before the repo or driver is touched, so a bare driver is
  // enough and keeps the arm about the scope rather than about session plumbing.
  return new SessionsService({ repo, driver: {} as Driver });
}

describe('V-1826 SessionsService.listAll stays internal-admin only', () => {
  it('CRITICAL requires the exact driftstack_internal_admin scope, not merely an elevated one', async () => {
    const svc = makeService();
    await expect(
      svc.listAll(ctxWithScopes(['account_owner']), { limit: 10 }),
      'account_owner is the strongest CUSTOMER scope and must not reach an all-tenant listing',
    ).rejects.toThrow(/driftstack_internal_admin/);
    await expect(
      svc.listAll(ctxWithScopes(['admin']), { limit: 10 }),
      'admin is not driftstack_internal_admin; the staff surface requires the exact scope',
    ).rejects.toThrow(/driftstack_internal_admin/);
  });

  // Non-vacuity. Without this, deleting `listAll` entirely — or making it throw
  // for everyone — would leave the arm above green and reading as a guard.
  it('CRITICAL and it RESOLVES for the internal-admin scope, so the arm above is a scope check and not a blanket refusal', async () => {
    const svc = makeService();
    await expect(
      svc.listAll(ctxWithScopes(['driftstack_internal_admin']), { limit: 10 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });
});
