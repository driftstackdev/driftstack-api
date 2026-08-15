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
// STILL UNMEASURED, deliberately left for a following pass rather than claimed:
// the three read-path guards at :122, :130 and :153 (canonical bounded base64 and
// the plaintext bound after decrypt). They need a forged envelope, and the
// bounded — not fixed — base64 shape means their reachability has to be settled
// the way the webhook module's was, empirically, before a test is written.
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
