// A matching control key authorizes only while its minter is live (security
// sweep #2) — the second half of every control-key gate, on its own.
//
// `validateGuiControlKey` proves the presented key is THIS session's stored key.
// That used to be the whole check, so the key outlived the credential or the team
// membership that minted it. `requireLiveGuiControlKeyMinter` runs after it on all
// three gates (the session routes, the LiveKit re-mint, the transport report) and
// re-checks the recorded minter against the live rows. Its contract:
//
//   · a live minter passes, and nothing is cleared;
//   · a minter that no longer holds, or none recorded (a key minted before 0142),
//     gets the SAME generic 401 as a wrong key, and the stored key is cleared by a
//     compare-and-clear on the very ciphertext that matched;
//   · a failed clear is reported and the 401 stands — the clear is not what makes
//     the key refused;
//   · no authority wired → refused, never waved through.

import { describe, expect, it } from 'vitest';
import {
  requireLiveGuiControlKeyMinter,
  sameGuiControlKeyMinter,
  type ControlKeyBoundSession,
  type GuiControlKeyMinter,
  type GuiControlKeyMinterAuthority,
} from '../../src/lib/agent-session-control-key.js';
import { UnauthorizedError } from '../../src/lib/errors.js';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const MEMBER = '00000000-0000-4000-8000-0000000000bb';
const CIPHERTEXT = Buffer.from('the stored ciphertext');

const OWNER_MINTER: GuiControlKeyMinter = {
  accountId: OWNER,
  apiKeyId: '00000000-0000-4000-8000-00000000de51',
  webSessionId: null,
  membershipId: null,
};

function session(minter: GuiControlKeyMinter | null | undefined): ControlKeyBoundSession {
  return {
    id: 'agt_11111111-2222-3333-4444-555555555555',
    accountId: OWNER,
    guiControlKeyCiphertext: CIPHERTEXT,
    guiControlKeyExpiresAt: new Date(Date.now() + 60_000),
    ...(minter === undefined ? {} : { guiControlKeyMintedBy: minter }),
  };
}

function authority(live: boolean, clear: 'ok' | 'throws' = 'ok') {
  const calls: Array<{ minter: GuiControlKeyMinter; ownerAccountId: string }> = [];
  const cleared: Array<{ id: string; ciphertext: Buffer }> = [];
  const impl: GuiControlKeyMinterAuthority = {
    isGuiControlKeyMinterLive: (args) => {
      calls.push({ minter: args.minter, ownerAccountId: args.ownerAccountId });
      return Promise.resolve(live);
    },
    clearGuiControlKeyIfUnchanged: (args) => {
      cleared.push(args);
      return clear === 'ok' ? Promise.resolve(true) : Promise.reject(new Error('db down'));
    },
  };
  return { impl, calls, cleared };
}

describe('a matching control key authorizes only while its minter is live', () => {
  it('a live minter passes, is asked about THIS session’s owner, and nothing is cleared', async () => {
    const a = authority(true);
    await expect(
      requireLiveGuiControlKeyMinter({ session: session(OWNER_MINTER), authority: a.impl }),
    ).resolves.toBeUndefined();
    expect(a.calls).toEqual([{ minter: OWNER_MINTER, ownerAccountId: OWNER }]);
    expect(a.cleared).toEqual([]);
  });

  it('CRITICAL a minter that no longer holds gets the generic 401, and the key that matched is cleared by its own ciphertext', async () => {
    const a = authority(false);
    const s = session(OWNER_MINTER);
    const refused = requireLiveGuiControlKeyMinter({ session: s, authority: a.impl });
    await expect(refused).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(refused).rejects.toThrow('gui_control_key is missing, expired, or invalid.');
    expect(a.cleared).toEqual([{ id: s.id, ciphertext: CIPHERTEXT }]);
  });

  it('CRITICAL a key with no recorded minter — absent or null — is refused and cleared without asking the authority', async () => {
    for (const minter of [undefined, null]) {
      const a = authority(true);
      await expect(
        requireLiveGuiControlKeyMinter({ session: session(minter), authority: a.impl }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(a.calls).toEqual([]);
      expect(a.cleared).toHaveLength(1);
    }
  });

  it('a failed clear is reported and the 401 stands', async () => {
    const a = authority(false, 'throws');
    const reported: unknown[] = [];
    await expect(
      requireLiveGuiControlKeyMinter({
        session: session(OWNER_MINTER),
        authority: a.impl,
        onClearError: (err) => reported.push(err),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(reported).toHaveLength(1);
  });

  it('no authority wired, or no session, is refused — never waved through', async () => {
    await expect(
      requireLiveGuiControlKeyMinter({ session: session(OWNER_MINTER), authority: undefined }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      requireLiveGuiControlKeyMinter({ session: null, authority: authority(true).impl }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('the same principal is the same account, credential AND membership — any one differing is another principal', () => {
    const member: GuiControlKeyMinter = {
      accountId: MEMBER,
      apiKeyId: '00000000-0000-4000-8000-00000000de52',
      webSessionId: null,
      membershipId: '00000000-0000-4000-8000-0000000000cc',
    };
    expect(sameGuiControlKeyMinter(member, { ...member })).toBe(true);
    for (const other of [
      { ...member, accountId: OWNER },
      { ...member, apiKeyId: '00000000-0000-4000-8000-00000000de53' },
      { ...member, apiKeyId: null, webSessionId: '00000000-0000-4000-8000-0000000000dd' },
      { ...member, membershipId: null },
    ]) {
      expect(sameGuiControlKeyMinter(member, other)).toBe(false);
    }
  });
});
