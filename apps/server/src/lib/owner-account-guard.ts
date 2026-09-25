// Security sweep #16 — staff powers stop at the project owner's account.
//
// The master-owner model keeps pricing, platform secrets and rate cards away
// from staff (`requireOwner`), but every staff mutation on an account accepted
// the owner's account as its target. A suspended account cannot authenticate,
// so one staff key — rogue or stolen — could suspend the owner and lock them
// out of the tools that are theirs alone; delete also revoked their keys and
// sessions and cancelled their billing.
//
// So a staff suspend, delete or tier change is refused when the account is the
// owner's, unless the owner is the one asking (routes/admin-accounts.ts).
// Staff-listed accounts are NOT protected here: staff are peers, and what one of
// them does to another (a suspension, say) any other staff member or the owner
// can undo. The owner's account is the one nothing above it can restore.

import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from './errors.js';
import type { AccountContext, AccountRow } from '../services/auth.js';

/**
 * Throw when `target` is the configured project owner's account and the caller
 * is not the owner. No owner configured → nothing is protected (and no one
 * passes `requireOwner` either). `action` completes "Only the project owner can
 * <action> the project owner's account."
 */
export function refuseStaffActionOnTheOwner(
  ctx: AccountContext,
  target: Pick<AccountRow, 'email'>,
  ownerEmail: string | null | undefined,
  action: string,
): void {
  const owner = ownerEmail?.trim().toLowerCase() ?? '';
  if (owner.length === 0) return;
  if (target.email.toLowerCase() !== owner) return;
  if (ctx.account.email.toLowerCase() === owner) return;
  throw new ForbiddenError(`Only the project owner can ${action} the project owner's account.`);
}

// Security sweep #17 — the owner tools that reveal or change platform secrets,
// prices and rate cards need a signed-in session and, when two-factor is on, a
// second factor proved in the last five minutes. An owner web-session token lives
// in the admin panel's localStorage; before this it revealed every secret however
// old its two-factor proof was, while turning two-factor off demanded a fresh code.
// Every one of them refuses an API key, including the rate-card routes that have
// no admin-panel screen: an owner session holds the staff scope and POST
// /v1/api-keys asks for no second factor, so a stolen session could mint a staff
// key and use it on any owner tool that took one.

/** How recently the owner must have proved a second factor to use those tools. */
export const OWNER_TOOL_MFA_FRESHNESS_SECONDS = 5 * 60;

/**
 * preHandler: refuse an API key. The step-up gate lets every API key through by
 * design (it is a human factor), so without this an owner key carrying the staff
 * scope would skip the second factor entirely. Place it after the owner check,
 * which authenticates.
 */
export function requireOwnerSignedInSession(request: FastifyRequest): Promise<void> {
  const ctx = request.account;
  if (!ctx) throw new Error('account context missing after requireAuth');
  if (ctx.webSession === null) {
    throw new ForbiddenError(
      'This owner tool can be used only from a signed-in admin session, not with an API key.',
    );
  }
  // A promise, not a bare return: a one-argument synchronous preHandler is
  // treated as callback-style and would leave the request waiting.
  return Promise.resolve();
}
