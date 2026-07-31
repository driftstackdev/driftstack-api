// Shared per-session gui_control_key validator.
//
// The Simulator (gui-client) holds ONLY a per-session gui_control_key — it
// never has the account API key. Several agent-session control endpoints
// (mode read/set, input-event, takeover, handback) accept EITHER that
// control key OR the normal account auth via the `controlKeyOrAccountAuth`
// preHandler in routes/agent-sessions.ts. The reconnect/re-mint path
// (POST /v1/agent-sessions/:id/livekit-token) is registered in a separate
// module, so the validation logic is extracted here as the single source of
// truth shared by both call sites (avoids the two drifting apart).
//
// Semantics (identical to the original in-route implementation):
//   - No control-key header present → { authorized: false } (caller falls
//     through to the account-auth path).
//   - A header IS present → every failure is a hard 401 (never a fallthrough
//     to account data with attacker-controlled input). Unknown session,
//     never-minted/expired key, key-rotation decrypt failure, and a mismatched
//     key all surface as the SAME generic 401 (never confirm a session exists
//     for another account).
//   - A valid key → { authorized: true, ownerAccountId } (the owning account,
//     so rate-limiting can charge the right bucket).

import { timingSafeEqual } from 'node:crypto';
import { decryptGuiControlKey } from './gui-control-key-encryption.js';
import { UnauthorizedError } from './errors.js';

/** Fastify normalises header names to lowercase. */
export const GUI_CONTROL_KEY_HEADER = 'x-driftstack-gui-control-key';

/** The minimal session shape the validator reads. Both the agent-sessions
 *  service record and the livekit-token route's repo record satisfy this. */
export interface ControlKeyBoundSession {
  id: string;
  accountId: string;
  guiControlKeyCiphertext: Buffer | null;
  guiControlKeyExpiresAt: Date | null;
}

export type ControlKeyValidation =
  | { authorized: false }
  | { authorized: true; ownerAccountId: string };

export interface ValidateControlKeyArgs {
  /** Raw header value (string | string[] | undefined), as Fastify exposes it. */
  headerRaw: string | string[] | undefined;
  /** The control-key-bound session, or null when the session doesn't exist. */
  session: ControlKeyBoundSession | null;
  /** MFA_ENCRYPTION_KEY (base64). Undefined when control-key auth is disabled. */
  encryptionKey: string | undefined;
  /** Now-provider (test-injectable). Defaults to Date.now. */
  nowMs?: () => number;
}

/**
 * Validate a presented per-session gui_control_key against the bound session.
 * Throws UnauthorizedError on any failure once a header is present; returns
 * `{ authorized: false }` only when no header was offered.
 *
 * SCOPE: this is a pure function over the session row, the ciphertext and the
 * clock. It deliberately takes no repository, so it cannot and does not check
 * the OWNING ACCOUNT's status — a key minted before a suspension still passes
 * here. Account status is enforced downstream, where the owner's live authority
 * is already being read: see the control-key branch of `controlKeyOrAccountAuth`
 * in routes/agent-sessions.ts and the owner-authority load in
 * middleware/rate-limit.ts. Anything that authorizes on this result alone, with
 * no such downstream read, is incomplete.
 */
export function validateGuiControlKey(args: ValidateControlKeyArgs): ControlKeyValidation {
  const { headerRaw, session, encryptionKey } = args;
  const now = args.nowMs ?? (() => Date.now());
  const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (header === undefined || header.length === 0) {
    // No control key offered → account-auth path decides.
    return { authorized: false };
  }
  // A control key was presented; from here every failure is a hard 401
  // (never a fallthrough to account data).
  if (encryptionKey === undefined) {
    throw new UnauthorizedError('gui_control_key auth is not enabled on this deployment.');
  }
  if (
    session === null ||
    session.guiControlKeyCiphertext === null ||
    session.guiControlKeyExpiresAt === null ||
    session.guiControlKeyExpiresAt.getTime() <= now()
  ) {
    // Unknown session, never-minted key, or expired → reject. Never confirm
    // whether the session exists for another account.
    throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
  }
  let expected: string;
  try {
    expected = decryptGuiControlKey(session.guiControlKeyCiphertext, encryptionKey, {
      accountId: session.accountId,
      sessionId: session.id,
    });
  } catch {
    // Ciphertext that won't decrypt (key rotation / corruption) is treated as
    // no valid key — reject, don't 500.
    throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
  }
  const presented = Buffer.from(header, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal-length buffers; the length check
  // short-circuits before the constant-time compare. The plaintext format is
  // fixed-length (`gck_` + 32 base32 chars), so a correct key always matches
  // length; differing lengths are always wrong.
  if (presented.length !== expectedBuf.length || !timingSafeEqual(presented, expectedBuf)) {
    throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
  }
  return { authorized: true, ownerAccountId: session.accountId };
}
