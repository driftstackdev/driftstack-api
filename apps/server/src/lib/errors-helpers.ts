// Helpers that need the AccountContext type but live next to errors.ts so
// services can import without pulling the auth service.

import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from '../services/auth.js';
import { ForbiddenError, NotFoundError } from './errors.js';

/**
 * V-174 — scope check with `'admin'` compat alias. During the
 * migration window, an `'admin'`-scoped key satisfies both
 * `'account_owner'` and `'driftstack_internal_admin'` checks. Mirrors
 * `services/auth.ts::requireScope` (kept in sync — both call sites
 * use the same predicate).
 */
export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  if (ctx.apiKey.scopes.includes(required)) return;
  if (
    (required === 'account_owner' || required === 'driftstack_internal_admin') &&
    ctx.apiKey.scopes.includes('admin')
  ) {
    return;
  }
  throw new ForbiddenError(`This action requires the "${required}" scope.`);
}

export { NotFoundError };
