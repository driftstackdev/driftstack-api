// Helpers that need the AccountContext type but live next to errors.ts so
// services can import without pulling the auth service.

import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from '../services/auth.js';
import { ForbiddenError, NotFoundError } from './errors.js';

export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  if (!ctx.apiKey.scopes.includes(required)) {
    throw new ForbiddenError(`This action requires the "${required}" scope.`);
  }
}

export { NotFoundError };
