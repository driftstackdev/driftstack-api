import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PROXY_SECRET_V2_PREFIX,
  convertAccountProxySecretToV2,
  encryptAccountProxySecret,
  readAccountProxySecret,
  type AccountProxySecretContext,
} from '../../src/lib/account-proxy-secret-encryption.js';
import { deriveTenantMasterKey, wrapAccountSecret } from '../../src/lib/profile-key-hierarchy.js';

const MASTER = Buffer.alloc(32, 81);
const WRONG_MASTER = Buffer.alloc(32, 82);
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const PROXY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROXY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WG_KEY = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const OVPN_SECRET = JSON.stringify({
  config_blob: 'client\nremote vpn.example.com 1194\n',
  password: 'vpn-password',
});

function rawV2(args: {
  context: AccountProxySecretContext;
  plaintext: Buffer;
  purpose?: string;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    deriveTenantMasterKey(MASTER, args.context.accountId),
    iv,
  );
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        args.purpose ?? 'driftstack.account-proxy-secret',
        2,
        args.context.accountId,
        args.context.proxyId,
        args.context.slot,
      ]),
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(args.plaintext), cipher.final()]);
  return `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64')}`;
}

describe('account proxy secret v2 encryption', () => {
  it('round-trips each semantic slot with an explicit v2 envelope', () => {
    const cases = [
      { slot: 'password' as const, value: 'hunter2' },
      { slot: 'openvpn-config' as const, value: OVPN_SECRET },
      { slot: 'wireguard-private-key' as const, value: WG_KEY },
    ];
    for (const testCase of cases) {
      const context = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: testCase.slot };
      const stored = encryptAccountProxySecret(MASTER, context, testCase.value);
      expect(stored.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)).toBe(true);
      expect(readAccountProxySecret(MASTER, context, stored)).toBe(testCase.value);
    }
  });

  it('binds account, proxy, slot, purpose and master key', () => {
    const context = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' as const };
    const stored = encryptAccountProxySecret(MASTER, context, 'hunter2');
    for (const wrongContext of [
      { ...context, accountId: ACCOUNT_B },
      { ...context, proxyId: PROXY_B },
      { ...context, slot: 'wireguard-private-key' as const },
    ]) {
      expect(() => readAccountProxySecret(MASTER, wrongContext, stored)).toThrow();
    }
    expect(() => readAccountProxySecret(WRONG_MASTER, context, stored)).toThrow();
    const wrongPurpose = rawV2({
      context,
      plaintext: Buffer.from('hunter2'),
      purpose: 'driftstack.account-proxy-secret.other',
    });
    expect(() => readAccountProxySecret(MASTER, context, wrongPurpose)).toThrow();
  });

  it('keeps account-only legacy input bootstrap-only and rewraps it for the exact row', () => {
    const context = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' as const };
    const legacy = wrapAccountSecret(MASTER, ACCOUNT_A, Buffer.from('legacy-password'));
    expect(() => readAccountProxySecret(MASTER, context, legacy)).toThrow(/not a v2/i);
    const migrated = convertAccountProxySecretToV2(MASTER, context, legacy);
    expect(readAccountProxySecret(MASTER, context, migrated)).toBe('legacy-password');
    expect(convertAccountProxySecretToV2(MASTER, context, migrated)).toBe(migrated);
    expect(() =>
      readAccountProxySecret(MASTER, { ...context, proxyId: PROXY_B }, migrated),
    ).toThrow();
  });

  it('rejects noncanonical, truncated, extended and tampered payloads before/at authentication', () => {
    const context = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' as const };
    const stored = encryptAccountProxySecret(MASTER, context, 'hunter2');
    const payload = stored.slice(ACCOUNT_PROXY_SECRET_V2_PREFIX.length);
    const blob = Buffer.from(payload, 'base64');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered.at(-1)! ^ 1;
    for (const candidate of [
      `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${payload} `,
      `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${blob.subarray(0, blob.length - 1).toString('base64')}`,
      `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${Buffer.concat([blob, Buffer.from([0])]).toString('base64')}`,
      `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${tampered.toString('base64')}`,
    ]) {
      expect(() => readAccountProxySecret(MASTER, context, candidate)).toThrow();
    }
  });

  it('validates exact UTF-8 and the authenticated slot schema after GCM authentication', () => {
    const passwordContext = {
      accountId: ACCOUNT_A,
      proxyId: randomUUID(),
      slot: 'password' as const,
    };
    expect(() =>
      readAccountProxySecret(
        MASTER,
        passwordContext,
        rawV2({ context: passwordContext, plaintext: Buffer.from([0xc3, 0x28]) }),
      ),
    ).toThrow(/UTF-8/i);

    const openVpnContext = {
      accountId: ACCOUNT_A,
      proxyId: randomUUID(),
      slot: 'openvpn-config' as const,
    };
    for (const value of [
      '{',
      JSON.stringify({ config_blob: 'client\nremote vpn.example 1194\n', extra: true }),
      JSON.stringify({ config_blob: 'remote vpn.example 1194\n' }),
    ]) {
      expect(() =>
        readAccountProxySecret(
          MASTER,
          openVpnContext,
          rawV2({ context: openVpnContext, plaintext: Buffer.from(value) }),
        ),
      ).toThrow();
    }

    const wireGuardContext = {
      accountId: ACCOUNT_A,
      proxyId: randomUUID(),
      slot: 'wireguard-private-key' as const,
    };
    expect(() =>
      readAccountProxySecret(
        MASTER,
        wireGuardContext,
        rawV2({ context: wireGuardContext, plaintext: Buffer.from('not-a-private-key') }),
      ),
    ).toThrow(/private key/i);
  });

  it('enforces per-slot plaintext and key/context bounds on new writes', () => {
    expect(() =>
      encryptAccountProxySecret(
        MASTER,
        { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' },
        '',
      ),
    ).toThrow();
    expect(() =>
      encryptAccountProxySecret(
        MASTER,
        { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' },
        'x'.repeat(1025),
      ),
    ).toThrow();
    expect(() =>
      encryptAccountProxySecret(
        Buffer.alloc(31),
        { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' },
        'x',
      ),
    ).toThrow(/32/);
    expect(() =>
      encryptAccountProxySecret(
        MASTER,
        { accountId: 'not-a-uuid', proxyId: PROXY_A, slot: 'password' },
        'x',
      ),
    ).toThrow(/UUID/);
  });

  it('CRITICAL refuses an oversized plaintext BEFORE parsing it, not after', () => {
    // `validatePlaintext` bounds bytes FIRST, then parses. Deleting the upper
    // half of that bound left all 22,426 tests green, because every oversized
    // input is ALSO refused later — by the JSON schema, or by the per-slot
    // rules. The outcome is unchanged; what changes is that the server would
    // JSON.parse a multi-megabyte blob before deciding to refuse it. Refusing
    // pre-parse is the whole point of a byte bound, so the property to pin is
    // WHICH guard answers, not merely that something did.
    //
    // The existing bounds arm above cannot see this: it passes 1025 ASCII
    // characters to the password slot, which is 1025 bytes against a 4096-byte
    // bound, so the character rule refuses and the byte bound never speaks.
    const ovpn = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'openvpn-config' as const };
    const wg = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'wireguard-private-key' as const };

    const huge = JSON.stringify({ config_blob: 'x'.repeat(3 * 1024 * 1024) });
    expect(() => encryptAccountProxySecret(MASTER, ovpn, huge)).toThrow(/outside its byte bound/);

    // The WireGuard slot makes the boundary exact. One byte over is answered by
    // the byte bound; exactly at it the value passes the bound and is answered
    // by the slot schema instead. An off-by-one in either direction swaps which
    // error comes back, so both arms are required to pin it.
    expect(() => encryptAccountProxySecret(MASTER, wg, 'k'.repeat(45))).toThrow(
      /outside its byte bound/,
    );
    expect(() => encryptAccountProxySecret(MASTER, wg, 'k'.repeat(44))).toThrow(
      /WireGuard private key is invalid/,
    );

    // …and a legitimate 44-byte key still seals, so the bound is not simply
    // refusing everything at the limit.
    expect(encryptAccountProxySecret(MASTER, wg, WG_KEY)).toContain(ACCOUNT_PROXY_SECRET_V2_PREFIX);
  });
});

// Found by neutralising every `throw new ` in the module one at a time and
// recording which ones no test notices, run against ALL FOUR unit files that
// import it — not just this one, because "unnoticed by one file" is not
// "uncovered". 15 sites, control total 52: 7 covered, 8 unnoticed.
//
// These five are the reachable ones on the ENCRYPT path. Each fixture is valid
// in every respect except the one guard under test, so an earlier refusal cannot
// answer in its place — the master key is well-formed, the ids are UUIDs, and
// the slot is real unless the slot is what is being tested.
//
// This module seals VPN credentials and proxy passwords under the tenant master
// key. A guard that silently stops refusing here does not throw anything a
// customer sees; it stores something that cannot be read back.
//
// V-1380 — the read-path guards this note used to list as unmeasured have been settled.
// The two canonical-base64 ones are driven by the three arms above (shape check before
// decode, byte floor after decode, and the re-encode comparison). The plaintext bound
// after decrypt is UNREACHABLE, measured rather than reasoned: forging an envelope at
// each slot's bound + 1 and reading it back shows the envelope shape gate answering every
// time, never the plaintext bound. The last arm in this file pins that so the dead branch
// cannot quietly become a live untested one.
describe('account-proxy-secret-encryption — unnoticed encrypt-path refusals', () => {
  const ctx = (slot: AccountProxySecretContext['slot']): AccountProxySecretContext => ({
    accountId: ACCOUNT_A,
    proxyId: PROXY_A,
    slot,
  });

  it('CRITICAL refuses an unknown secret slot. The slot is AAD, so a slot the reader does not know is a blob that authenticates under a tuple nobody can reproduce — sealed and permanently unreadable.', () => {
    expect(() =>
      encryptAccountProxySecret(
        MASTER,
        // A non-TS caller, or drift in the slot union, is the case this defends.
        {
          accountId: ACCOUNT_A,
          proxyId: PROXY_A,
          slot: 'totally-not-a-slot',
        } as unknown as AccountProxySecretContext,
        'anything',
      ),
    ).toThrow(/slot is invalid/);
  });

  it('CRITICAL refuses an empty plaintext before the per-slot rules. An empty password would seal to a valid envelope that reads back as the empty string, which dispatch cannot distinguish from "no password configured".', () => {
    expect(() => encryptAccountProxySecret(MASTER, ctx('password'), '')).toThrow(
      /outside its byte bound/,
    );
  });

  it('CRITICAL refuses an OpenVPN secret that is not JSON, rather than sealing an opaque string the reader will fail on later', () => {
    expect(() =>
      encryptAccountProxySecret(MASTER, ctx('openvpn-config'), 'client\nremote vpn.example.com'),
    ).toThrow(/not valid JSON/);
  });

  it('CRITICAL refuses a JSON array for an OpenVPN secret — `typeof [] === "object"`, so an Array-vs-object check is a real branch and not a formality', () => {
    expect(() => encryptAccountProxySecret(MASTER, ctx('openvpn-config'), '[]')).toThrow(
      /must be an object/,
    );
  });

  it('CRITICAL refuses an OpenVPN secret whose key set is right but whose value type is wrong — the shape check passes, so only the schema check can catch this', () => {
    // Exactly the allowed key set, so the shape guard above it is satisfied and
    // the refusal can only come from the schema parse.
    expect(() =>
      encryptAccountProxySecret(MASTER, ctx('openvpn-config'), '{"config_blob":123}'),
    ).toThrow(/is invalid/);
  });
});

// The two bounded-base64 guards, made individually attributable.
//
// They are layered, and a mutation ledger showed why that matters: neutralising
// either one alone reds NOTHING, because the sibling catches the same input and
// the existing payload test asserts only `.toThrow()` with no message. Only
// mutating BOTH together reds it. So "no test notices this line" was true and
// would have been misleading — the pair is covered, the lines are not
// individually attributable.
//
// The gap that is real: that test is named for `noncanonical` payloads and does
// not contain one. Its four candidates are a trailing space (a SHAPE violation),
// a truncated blob, an extended blob, and a byte-tampered blob — the last three
// all produced by `Buffer.toString('base64')`, so every one of them is canonical
// by construction. Non-canonical base64 — trailing bits that are not zero, which
// decodes fine and re-encodes to a DIFFERENT string — was never exercised.
//
// Reachability here is unlike the webhook module's fixed-width envelope: this
// base64 is BOUNDED and admits padding, so both branches of the second guard are
// genuinely reachable. Each arm asserts its own message, so it names the guard
// that answered rather than accepting any refusal.
describe('account-proxy-secret-encryption — bounded base64, attributed', () => {
  const C: AccountProxySecretContext = { accountId: ACCOUNT_A, proxyId: PROXY_A, slot: 'password' };

  it('CRITICAL a non-canonical payload is refused by the post-decode canonicality check. Trailing bits that are not zero decode to the same bytes and re-encode to a different string, so a single stored secret would have several accepted spellings — the case the payload test is named for and does not contain.', () => {
    const body = encryptAccountProxySecret(MASTER, C, 'hunter2').slice(
      ACCOUNT_PROXY_SECRET_V2_PREFIX.length,
    );
    const nonCanonical = `${body.slice(0, -2)}R=`;
    // The premise, asserted rather than assumed: this really is non-canonical.
    expect(Buffer.from(nonCanonical, 'base64').toString('base64')).not.toBe(nonCanonical);
    expect(() =>
      readAccountProxySecret(MASTER, C, `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${nonCanonical}`),
    ).toThrow(/not canonical bounded base64/);
  });

  it('CRITICAL a payload that clears the character floor but decodes BELOW the minimum envelope is refused after decoding — the length floor is counted in characters, and padding makes those two different numbers', () => {
    // 40 chars clears the char floor; the '==' padding drops it to 28 decoded
    // bytes, one short of the 29-byte minimum envelope (12 IV + 16 tag + 1).
    const shortDecode = `${'A'.repeat(38)}==`;
    expect(shortDecode.length).toBe(40);
    expect(Buffer.from(shortDecode, 'base64').length).toBe(28);
    expect(() =>
      readAccountProxySecret(MASTER, C, `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${shortDecode}`),
    ).toThrow(/not canonical bounded base64/);
  });

  it('CRITICAL a payload outside the alphabet is refused BEFORE any decode, by the shape check rather than by its sibling', () => {
    expect(() =>
      readAccountProxySecret(MASTER, C, `${ACCOUNT_PROXY_SECRET_V2_PREFIX}!!!!not-base64!!!!`),
    ).toThrow(/outside its canonical bounded base64 shape/);
  });

  // V-1380 — why `plaintextBytes.length > maximumPlaintextBytes(slot)` after the decrypt
  // can never be true, pinned as behaviour rather than restated as arithmetic.
  //
  // `decodeCanonicalEnvelope` bounds the blob at `iv + tag + maximumPlaintextBytes(slot)`
  // — the SAME per-slot number — and AES-GCM does not pad, so the ciphertext is exactly as
  // long as the plaintext. `plaintext > max` and `blob > iv + tag + max` are therefore one
  // inequality, and the envelope gate reaches it first on every path: `decryptPayload` is
  // the only route in, and it always decodes through that gate (unlike the BYOK module,
  // where a legacy reader skips its equivalent).
  //
  // Measured: a forged envelope one byte past each slot's bound is answered by the shape
  // gate, never by the plaintext bound. If those two numbers ever diverge, the branch below
  // becomes reachable and untested — and this arm turns red first.
  it('CRITICAL an over-bound plaintext is refused by the ENVELOPE gate, so the plaintext bound behind it is unreachable. Which guard answers is the property: the two bounds are the same inequality 28 bytes apart, and pinning that is what keeps the dead branch dead rather than silently live.', () => {
    const cases = [
      { slot: 'wireguard-private-key' as const, max: 44 },
      { slot: 'password' as const, max: 4 * 1024 },
      { slot: 'openvpn-config' as const, max: 2 * 1024 * 1024 },
    ];

    for (const { slot, max } of cases) {
      const context: AccountProxySecretContext = {
        accountId: ACCOUNT_A,
        proxyId: PROXY_A,
        slot,
      };
      let message = '(no throw)';
      try {
        readAccountProxySecret(
          MASTER,
          context,
          rawV2({ context, plaintext: Buffer.alloc(max + 1, 97) }),
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `${slot}: one byte over the bound`).toMatch(/canonical bounded base64/i);
      expect(
        message,
        `${slot}: the plaintext bound must NOT be what answers — if it is, the envelope gate stopped covering it`,
      ).not.toMatch(/plaintext exceeds its byte bound/i);
    }

    // And exactly AT the bound the size gates are cleared, so this is a bound rather than a
    // refusal of everything large: the WireGuard slot gets as far as its own schema.
    const wg: AccountProxySecretContext = {
      accountId: ACCOUNT_A,
      proxyId: PROXY_A,
      slot: 'wireguard-private-key',
    };
    expect(() =>
      readAccountProxySecret(MASTER, wg, rawV2({ context: wg, plaintext: Buffer.alloc(44, 97) })),
    ).toThrow(/WireGuard private key is invalid/);
  });
});
