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
//
// Security sweep #2 — a key that matches is not yet a key that authorizes. The
// key skips every scope and ownership check on the session's routes, so it must
// die with the credential or the team membership that minted it. Every gate
// therefore follows the match with `requireLiveGuiControlKeyMinter`, which
// re-checks the stored minter against the live rows (the credential is not
// revoked or expired, a team member's membership still holds the admin role, the
// account is active) and, when that fails, clears the stored key and answers the
// same generic 401.

import { timingSafeEqual } from 'node:crypto';
import { decryptGuiControlKey } from './gui-control-key-encryption.js';
import { UnauthorizedError } from './errors.js';

/** Fastify normalises header names to lowercase. */
export const GUI_CONTROL_KEY_HEADER = 'x-driftstack-gui-control-key';

/**
 * Who minted a session's gui_control_key (migration 0142). The key lives exactly
 * as long as this principal may still act on the session.
 *
 * `accountId` is the CALLER: the session owner, or the team member acting for
 * them. Exactly one of `apiKeyId` / `webSessionId` names the credential the mint
 * was called with — an API key (a desktop device key and an OAuth grant are API
 * keys too) or a signed-in browser session. `membershipId` is the team membership
 * a member acted through, null when the owner minted the key.
 */
export interface GuiControlKeyMinter {
  accountId: string;
  apiKeyId: string | null;
  webSessionId: string | null;
  membershipId: string | null;
}

/** Same principal: same account, same credential, same membership. */
export function sameGuiControlKeyMinter(a: GuiControlKeyMinter, b: GuiControlKeyMinter): boolean {
  return (
    a.accountId === b.accountId &&
    a.apiKeyId === b.apiKeyId &&
    a.webSessionId === b.webSessionId &&
    a.membershipId === b.membershipId
  );
}

/** The minimal session shape the validator reads. Both the agent-sessions
 *  service record and the livekit-token route's repo record satisfy this. */
export interface ControlKeyBoundSession {
  id: string;
  accountId: string;
  guiControlKeyCiphertext: Buffer | null;
  guiControlKeyExpiresAt: Date | null;
  /** Who minted the stored key (0142). Absent or null → no recorded minter,
   *  which {@link requireLiveGuiControlKeyMinter} refuses. */
  guiControlKeyMintedBy?: GuiControlKeyMinter | null;
}

/**
 * The live authority a control-key gate re-checks on every use. Implemented by
 * the agent-sessions repository, which can read the credential, membership and
 * account rows the minter names.
 */
export interface GuiControlKeyMinterAuthority {
  /**
   * True only while `minter` may still act on `ownerAccountId`'s session: its API
   * key or web session is not revoked or expired (a web session also still at its
   * account's auth epoch), its account is active, and — when it acted through a
   * team membership — that membership still exists, belongs to the owner, holds
   * the admin role and the owner is active. A minter with no membership must BE
   * the owner.
   */
  isGuiControlKeyMinterLive(args: {
    minter: GuiControlKeyMinter;
    ownerAccountId: string;
    now: Date;
  }): Promise<boolean>;
  /**
   * Clear the stored key and its minter, only while the stored ciphertext is
   * still `ciphertext` (a key minted meanwhile is left alone). Returns whether a
   * row changed.
   */
  clearGuiControlKeyIfUnchanged(args: { id: string; ciphertext: Buffer }): Promise<boolean>;
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

export interface RequireLiveMinterArgs {
  /** The session row the presented key was just matched against. */
  session: ControlKeyBoundSession | null;
  /** The live authority. Undefined → no gate can re-check a minter: refuse. */
  authority: GuiControlKeyMinterAuthority | undefined;
  /** Now-provider (test-injectable). Defaults to Date.now. */
  nowMs?: () => number;
  /** Where a failed clear is reported. The 401 stands either way. */
  onClearError?: (err: unknown) => void;
}

/**
 * The second half of every control-key gate, run after {@link validateGuiControlKey}
 * authorized a presented key: re-check the principal that minted the key, as the
 * transcript stream's heartbeat re-authenticates its bearer. A key with no recorded
 * minter (minted before 0142) or whose minter is no longer live gets the same generic
 * 401 as a wrong key, and the stored key is cleared so it cannot come back — the next
 * account-authenticated mint then issues a fresh one.
 *
 * The minter read comes from the SAME session row whose ciphertext the key matched,
 * so a key minted meanwhile by someone else cannot lend its minter to this one; the
 * clear is a compare-and-clear on that ciphertext for the same reason.
 */
export async function requireLiveGuiControlKeyMinter(args: RequireLiveMinterArgs): Promise<void> {
  const { session, authority } = args;
  const now = args.nowMs ?? (() => Date.now());
  if (session === null || session.guiControlKeyCiphertext === null) {
    throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
  }
  if (authority === undefined) {
    throw new UnauthorizedError('gui_control_key auth is not enabled on this deployment.');
  }
  const minter = session.guiControlKeyMintedBy ?? null;
  const live =
    minter !== null &&
    (await authority.isGuiControlKeyMinterLive({
      minter,
      ownerAccountId: session.accountId,
      now: new Date(now()),
    }));
  if (live) return;
  try {
    await authority.clearGuiControlKeyIfUnchanged({
      id: session.id,
      ciphertext: session.guiControlKeyCiphertext,
    });
  } catch (err) {
    args.onClearError?.(err);
  }
  throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
}
