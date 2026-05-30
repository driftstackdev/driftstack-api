// Unit test for the admin-cost route's account-id normalizer. The cost lookups
// match accounts.id (a bare uuid) directly, so /v1/admin/cost/accounts/:id +
// /overview must accept EITHER the public `acc_<uuid>` form (what an operator
// pastes from the /accounts admin page) OR a bare uuid. Regression guard for
// the account-detail cost drill-in that 404'd on the prefixed id.
// See project_admin_cost_id_prefix_inconsistency.

import { describe, expect, it } from 'vitest';
import { bareAccountId } from '../../src/routes/admin-cost.js';

describe('admin-cost bareAccountId normalizer', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';

  it('strips the public acc_ prefix to the bare uuid', () => {
    expect(bareAccountId(`acc_${uuid}`)).toBe(uuid);
  });

  it('passes a bare uuid through unchanged (existing cost-page callers send bare)', () => {
    expect(bareAccountId(uuid)).toBe(uuid);
  });

  it('only strips the leading acc_ once — a real uuid contains no underscore so this is unambiguous', () => {
    expect(bareAccountId(`acc_acc_${uuid}`)).toBe(`acc_${uuid}`);
  });

  it('leaves a non-acc-prefixed value untouched', () => {
    expect(bareAccountId(`ses_${uuid}`)).toBe(`ses_${uuid}`);
  });
});
