// ARC A slice 4 — AccountProxiesService.resolveForDispatch security tests.
//
// resolveForDispatch is the sensitive path: it decrypts a stored proxy password
// (owner-scoped TMK) and re-asserts the SSRF host-guard before the proxy is
// injected into a session dispatch. Covered here: owner-scoping (B can't resolve
// A's proxy), password unwrap, SSRF fail-closed, http-scheme skip, no-key
// behaviour.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SocksProxyConfig } from '@driftstack/api-types';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import {
  AccountProxiesService,
  UnsafeProxyHostError,
  WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD,
} from '../../src/services/account-proxies.js';
import { encryptAccountProxySecret } from '../../src/lib/account-proxy-secret-encryption.js';

const MASTER = Buffer.alloc(32, 7);
/** (V4 follow-up) — a DIFFERENT deployment key, so a row encrypted under MASTER
 *  fails GCM for its own owner. That is the wrong-TMK / post-rotation /
 *  corrupted-blob case (`secret_unreadable`), and it is NOT the same thing as a
 *  cross-account read (which the repo refuses first, as `not_found`). */
const OTHER_MASTER = Buffer.alloc(32, 9);
const ACCT_A = '11111111-1111-1111-1111-111111111111';
const ACCT_B = '22222222-2222-2222-2222-222222222222';

async function seed(
  repo: InMemoryAccountProxiesRepo,
  accountId: string,
  over: Partial<Parameters<InMemoryAccountProxiesRepo['create']>[1]> = {},
) {
  const id = over.id ?? randomUUID();
  return repo.create(accountId, {
    label: 'p',
    scheme: 'socks5',
    host: 'proxy.customer.example',
    port: 1080,
    username: 'user',
    wrappedPassword: encryptAccountProxySecret(
      MASTER,
      { accountId, proxyId: id, slot: 'password' },
      'hunter2',
    ),
    ...over,
    id,
  });
}

describe('AccountProxiesService.resolveForDispatch', () => {
  it('resolves a socks5 proxy and unwraps the password under the owner TMK', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg).not.toBeNull();
    expect(cfg?.host).toBe('proxy.customer.example');
    expect(cfg?.port).toBe(1080);
    expect(cfg?.username).toBe('user');
    expect(cfg?.password).toBe('hunter2');
    expect(cfg?.require_remote_dns).toBe(true);
  });

  // Proxy UDP pre-detection (A3 W2756): resolveForDispatch emits a VERIFIED,
  // FRESH (within the 7-day TTL) udp_capable on the wire so the harness can skip
  // the per-session ~3s probe; stale/absent → omitted → fork async-probe (today).
  const recentIso = (): string => new Date(Date.now() - 60_000).toISOString();
  const staleIso = (): string => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  it('udp_capable: a FRESH verified TRUE is emitted on the wire', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, {
      config: { udp_capable: true, udp_verified_at: recentIso() },
    });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg?.udp_capable).toBe(true);
  });

  it('udp_capable: a FRESH verified FALSE (TCP-only) is emitted so the fork skips the probe + disables h3', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, {
      config: { udp_capable: false, udp_verified_at: recentIso() },
    });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg?.udp_capable).toBe(false);
  });

  it('udp_capable: a STALE verified value (older than the 7-day TTL) is OMITTED → fork re-probes', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, {
      config: { udp_capable: true, udp_verified_at: staleIso() },
    });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg).not.toBeNull();
    expect(cfg?.udp_capable).toBeUndefined();
  });

  it('udp_capable: ABSENT (no verified value — the default) is OMITTED → fork async-probe = today’s safe behavior', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg).not.toBeNull();
    expect(cfg?.udp_capable).toBeUndefined();
  });

  it('OWNER SCOPING: account B cannot resolve account A’s proxy (null, never decrypts)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    expect(
      await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_B, tier: 'api_builder' }),
    ).toBeNull();
  });

  it('unknown id → null', async () => {
    const svc = new AccountProxiesService(new InMemoryAccountProxiesRepo(), MASTER);
    expect(
      await svc.resolveForDispatch({ proxyId: 'nope', accountId: ACCT_A, tier: 'api_builder' }),
    ).toBeNull();
  });

  it('SSRF FAIL-CLOSED: a stored private/loopback host throws UnsafeProxyHostError', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', 'localhost', '::1']) {
      const row = await seed(repo, ACCT_A, { host });
      await expect(
        svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A, tier: 'api_builder' }),
      ).rejects.toThrow(UnsafeProxyHostError);
    }
  });

  it('http-scheme proxy is not dispatch-injectable yet → null', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { scheme: 'http' });
    expect(
      await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A, tier: 'api_builder' }),
    ).toBeNull();
  });

  it('no master key with a stored password fails closed', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, null);
    const row = await seed(repo, ACCT_A);
    const cfg = await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(cfg).toBeNull();
  });

  it('a proxy with no stored password resolves without one', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { wrappedPassword: null, username: null });
    const cfg = (await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    })) as (SocksProxyConfig & { udp_capable?: boolean | null }) | null;
    expect(cfg?.password).toBeUndefined();
    expect(cfg?.username).toBeUndefined();
  });

  // OVPN/WG slice 4 — VPN rows resolve to the FLAT inline wire (A3 W2163), with
  // the secret unwrapped under the owner TMK + cross-account isolation preserved.
  it('resolves a WireGuard proxy to the FLAT wire (type sibling fields, secret unwrapped)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      ),
      config: {
        peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    });
    const cfg = await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(cfg).toEqual({
      type: 'wireguard',
      private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    });
  });

  // WireGuard PresharedKey: stored as its own envelope in `config` under the
  // private-key slot (see WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD), unwrapped here
  // and carried on the flat wire. A peer configured with a PSK refuses a
  // handshake without it, so a row that stored it and a wire that dropped it
  // would be a tunnel that never comes up with nothing naming the cause.
  const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
  const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
  const PSK = 'P'.repeat(43) + '=';
  async function seedWireGuardWithPsk(
    repo: InMemoryAccountProxiesRepo,
    pskWrappedFor: { accountId: string; proxyId: string } | 'this-row',
  ) {
    const id = randomUUID();
    const pskContext =
      pskWrappedFor === 'this-row' ? { accountId: ACCT_A, proxyId: id } : pskWrappedFor;
    return repo.create(ACCT_A, {
      id,
      label: 'wg-psk',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        WG_PRIV,
      ),
      config: {
        peer_public_key: WG_PUB,
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
        [WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD]: encryptAccountProxySecret(
          MASTER,
          { ...pskContext, slot: 'wireguard-preshared-key' },
          PSK,
        ),
      },
    });
  }

  it('carries preshared_key on the wire when the row has one — unwrapped from its envelope in config, never read from the jsonb in the clear', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedWireGuardWithPsk(repo, 'this-row');
    // Control on the fixture: the stored jsonb does not hold the key in the clear,
    // so the value on the wire below can only have come from the unwrap.
    expect(JSON.stringify(row.config)).not.toContain(PSK);
    const cfg = await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(cfg).toEqual({
      type: 'wireguard',
      private_key: WG_PRIV,
      peer_public_key: WG_PUB,
      preshared_key: PSK,
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    });
    // The envelope itself must not leak onto the wire beside the plaintext.
    expect(JSON.stringify(cfg)).not.toContain(WIREGUARD_WRAPPED_PRESHARED_KEY_FIELD);
  });

  it('FAIL-CLOSED: a preshared_key envelope that does not unwrap for this row (wrapped for another proxy) resolves to null. The private key alone is valid — the arm above proves it — so the null can only be the PSK unwrap; dispatching the row WITHOUT the key would be a tunnel the peer refuses.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedWireGuardWithPsk(repo, { accountId: ACCT_A, proxyId: randomUUID() });
    expect(
      await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A, tier: 'api_builder' }),
    ).toBeNull();
  });

  it('resolves an OpenVPN proxy to the FLAT wire (config_blob from the unwrapped secret)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'ovpn',
      scheme: 'openvpn',
      host: 'vpn.example.com',
      port: 1194,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'openvpn-config' },
        JSON.stringify({ config_blob: 'client\nremote vpn.example.com 1194\n' }),
      ),
      config: { username: 'u' },
    });
    const cfg = await svc.resolveForDispatch({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(cfg).toEqual({
      type: 'openvpn',
      config_blob: 'client\nremote vpn.example.com 1194\n',
      username: 'u',
    });
  });

  it('OWNER SCOPING (VPN): account B cannot resolve account A’s WireGuard secret → null (GCM unwrap fails)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      ),
      config: {
        peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    });
    expect(
      await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_B, tier: 'api_builder' }),
    ).toBeNull();
  });
});

describe('AccountProxiesService.findOwned', () => {
  it('returns the row for the owner, null cross-account', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    expect((await svc.findOwned(row.id, ACCT_A))?.id).toBe(row.id);
    expect(await svc.findOwned(row.id, ACCT_B)).toBeNull();
  });
});

// ─── (V3 2026-09-12) — resolveForDispatchWithReason: a null carries its CAUSE ──
//
// Owner: "openvpn (possibily wireguard too) … session not starting still".
// MEASURED before this: nine distinct causes reached the launch-blocking call
// sites as one `null`, and both of them answered it with ONE sentence — "its
// stored configuration could not be read. Re-add it and try again." For the two
// POLICY refusals (a `script-security 2` line the control plane will not run; a
// `ca ca.crt` reference no session can resolve) and for a config missing a
// required field, that sentence is FALSE: nothing failed to decrypt, and a
// re-add of the same file is refused again. The launch failure could therefore
// be neither explained to the customer nor triaged from the log.
//
// These arms pin: each cause names itself; the three genuinely-unreadable causes
// KEEP the shipped sentence (the customer's action is unchanged and the code is
// what separates them); a healthy row reports NO reason (the vacuity control —
// a resolver that returned a reason unconditionally would pass every arm above);
// and `resolveForDispatch` is still exactly `.config`, so every existing caller
// and every test that reads it is unaffected.

/** A stored OpenVPN row with an arbitrary blob — the shape a row written by an
 *  older build (or any other writer) has: the create route's guards never ran. */
async function seedOpenvpn(
  repo: InMemoryAccountProxiesRepo,
  accountId: string,
  configBlob: string,
) {
  const id = randomUUID();
  return repo.create(accountId, {
    id,
    label: 'ovpn',
    scheme: 'openvpn',
    host: 'vpn.example.com',
    port: 1194,
    username: null,
    wrappedPassword: null,
    wrappedSecret: encryptAccountProxySecret(
      MASTER,
      { accountId, proxyId: id, slot: 'openvpn-config' },
      JSON.stringify({ config_blob: configBlob }),
    ),
    config: {},
  });
}

const CLEAN_OVPN = 'client\nremote vpn.example.com 1194\n<ca>\nPEM\n</ca>\n';
const UNREADABLE_SENTENCE = 'could not be read. Re-add it and try again.';

describe('AccountProxiesService.resolveForDispatchWithReason — the cause of a null', () => {
  it('a script-executing directive is a POLICY refusal that names the line, never "could not be read"', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedOpenvpn(
      repo,
      ACCT_A,
      'client\nremote vpn.example.com 1194\nscript-security 2\n<ca>\nPEM\n</ca>\n',
    );
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('config_refused_directive');
    // The SAME sentence the create/update route answers the same blob with,
    // naming the same line — so a customer who reads one and then the other is
    // not told two different stories.
    expect(r.detail).toContain('Line 3: "script-security 2"');
    expect(r.detail).not.toContain(UNREADABLE_SENTENCE);
  });

  it('an external cert/key reference is refused HERE (cross-pinned with the node parse-reject), naming the line', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedOpenvpn(repo, ACCT_A, 'client\nremote vpn.example.com 1194\nca ca.crt\n');
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('config_refused_file_reference');
    expect(r.detail).toContain('ca ca.crt');
    expect(r.detail).not.toContain(UNREADABLE_SENTENCE);
  });

  it('a VPN config missing a required field names the field AS THE FILE NAMES IT (WireGuard `Address`)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const row = await repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      ),
      // `address` absent — the row shape a WG proxy stored before it was
      // captured has, which fails closed on EVERY launch.
      config: {
        peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
      },
    });
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('config_incomplete');
    expect(r.detail).toContain('Address');
    expect(r.detail).not.toContain('address)'); // the WIRE name is never shown
    expect(r.detail).not.toContain(UNREADABLE_SENTENCE);
  });

  it('the three UNREADABLE causes keep the shipped sentence (the action is the same; the CODE separates them)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const id = randomUUID();
    const noSecret = await repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: null,
      config: {},
    });
    const missing = await svc.resolveForDispatchWithReason({
      proxyId: noSecret.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(missing.config).toBeNull();
    expect(missing.reason).toBe('secret_missing');
    expect(missing.detail).toContain(UNREADABLE_SENTENCE);

    // ⛔ (V4 follow-up 2026-09-12) — THIS LEG USED TO ASSERT A DIFFERENT CAUSE
    // THAN THE ARM'S TITLE. It read the row as ACCT_B and its own comment
    // conceded the consequence — "ACCT_B does not own the row at all, so the
    // repo answers first" — so it asserted `not_found`, and the wrong-TMK /
    // corrupted-blob case (`secret_unreadable`) the arm was written for was
    // never reached. Measured by mutation: replacing the `secret_unreadable`
    // sentence read GREEN against 23 server files. The cross-account leg is a
    // real property and keeps its own arm below; THIS is the GCM failure —
    // the row's own owner, a deployment key that cannot unwrap it.
    const ovpn = await seedOpenvpn(repo, ACCT_A, CLEAN_OVPN);
    const rotated = new AccountProxiesService(repo, OTHER_MASTER);
    const gcmFailed = await rotated.resolveForDispatchWithReason({
      proxyId: ovpn.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(gcmFailed.config).toBeNull();
    expect(gcmFailed.reason).toBe('secret_unreadable');
    expect(gcmFailed.detail).toContain(UNREADABLE_SENTENCE);
    // …and it is the VPN wording, not the socks5 one (the two differ by a noun
    // the customer reads).
    expect(gcmFailed.detail).toContain('VPN');

    // No master key on the deployment: nothing here can be unwrapped.
    const noKey = new AccountProxiesService(repo, null);
    const unkeyed = await noKey.resolveForDispatchWithReason({
      proxyId: ovpn.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(unkeyed.config).toBeNull();
    expect(unkeyed.reason).toBe('encryption_unavailable');
    expect(unkeyed.detail).toContain(UNREADABLE_SENTENCE);
  });

  it('an http row says an HTTP proxy cannot carry a session — not that its config is unreadable', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { scheme: 'http' });
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('scheme_not_dispatchable');
    expect(r.detail).toContain('HTTP proxy');
  });

  it('VACUITY CONTROL — a healthy row resolves with NO reason, and `resolveForDispatch` is exactly `.config`', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const ovpn = await seedOpenvpn(repo, ACCT_A, CLEAN_OVPN);
    const r = await svc.resolveForDispatchWithReason({
      proxyId: ovpn.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.reason).toBeUndefined();
    expect(r.detail).toBeUndefined();
    expect(r.config).toEqual({ type: 'openvpn', config_blob: CLEAN_OVPN });
    // The compatibility pin: the old signature returns the same object, and a
    // null for a refused row (so every existing caller is unchanged).
    expect(
      await svc.resolveForDispatch({ proxyId: ovpn.id, accountId: ACCT_A, tier: 'api_builder' }),
    ).toEqual(r.config);
    const refused = await seedOpenvpn(repo, ACCT_A, `${CLEAN_OVPN}up /etc/openvpn/up.sh\n`);
    expect(
      await svc.resolveForDispatch({ proxyId: refused.id, accountId: ACCT_A, tier: 'api_builder' }),
    ).toBeNull();
  });
});

// ⛔ (V4 follow-up 2026-09-12) — THE REASON CODES NOTHING WAS ASSERTING.
//
// `ProxyUnresolvableReason` exists so triage picks the cause out of a log line
// without a repro. MEASURED by mutation against 23 server files / 373 tests:
// mislabelling `secret_unreadable`, `config_refused_target` (both producers) and
// the socks5 `encryption_unavailable` — and rewriting their sentences — read
// GREEN. A mislabel is exactly the defect the closed set exists to prevent, and
// `config_refused_target` is the SSRF case an on-call engineer most needs to be
// true.
//
// Table-driven, one fixture per reachable code, asserting the pair {reason,
// detail}. MUTATION (run): swap any row's emitted `reason` in the service → that
// row reds by name.
//
// ⚠️ NOT IN THE TABLE, and why — measured, not assumed:
//   * `config_unreadable` (the JSON.parse / non-string `config_blob` arms) is
//     UNREACHABLE through the encryption module. `validatePlaintext` parses and
//     re-serialises the OpenVPN secret on BOTH write and read
//     (`decryptPayload`'s last statement), so a stored blob that is not the
//     canonical `{config_blob[,password]}` JSON cannot exist, and one corrupted
//     at rest throws on read → `secret_unreadable`. It is defence-in-depth with
//     no producer; a fixture for it would have to fabricate a row the system
//     cannot make. Named here so the next reader does not re-derive it.
//   * `not_found`, `scheme_not_dispatchable`, `secret_missing`,
//     `encryption_unavailable` (VPN), `config_refused_directive`,
//     `config_refused_file_reference`, `config_incomplete` each have their own
//     arm above.
describe('(V4) every REACHABLE ProxyUnresolvableReason is asserted by code AND sentence', () => {
  const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
  const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

  async function seedWireguard(repo: InMemoryAccountProxiesRepo, config: Record<string, unknown>) {
    const id = randomUUID();
    return repo.create(ACCT_A, {
      id,
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: encryptAccountProxySecret(
        MASTER,
        { accountId: ACCT_A, proxyId: id, slot: 'wireguard-private-key' },
        WG_PRIV,
      ),
      config,
    });
  }

  const HEALTHY_WG = {
    peer_public_key: WG_PUB,
    endpoint: 'vpn.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  };

  it('CRITICAL socks5 encryption_unavailable — the deployment has no master key, so a stored password cannot be unwrapped', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const row = await seed(repo, ACCT_A); // socks5 WITH a wrapped password
    const r = await new AccountProxiesService(repo, null).resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('encryption_unavailable');
    // The PROXY wording, not the VPN one.
    expect(r.detail).toBe(
      'This proxy’s stored configuration could not be read. Re-add it and try again.',
    );
  });

  it('CRITICAL socks5 secret_unreadable — the row is the owner’s, the key cannot unwrap it (rotation / corruption)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const row = await seed(repo, ACCT_A);
    const r = await new AccountProxiesService(repo, OTHER_MASTER).resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('secret_unreadable');
    expect(r.detail).toContain(UNREADABLE_SENTENCE);
    expect(r.detail).not.toContain('VPN');
  });

  it('CRITICAL WireGuard config_refused_target — the tunnel’s own endpoint is a loopback address (SSRF re-guard at dispatch)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    // The DISPLAY host is public and passes `classifyUnsafeHost`; the real
    // egress is the endpoint, which is the one this code re-guards.
    const row = await seedWireguard(repo, { ...HEALTHY_WG, endpoint: '127.0.0.1:51820' });
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('config_refused_target');
    expect(r.detail).toContain('private, loopback, link-local, or metadata address');
    expect(r.detail).not.toContain(UNREADABLE_SENTENCE);
  });

  it('CRITICAL OpenVPN config_refused_target — the blob’s `remote` is a loopback address', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedOpenvpn(
      repo,
      ACCT_A,
      'client\nremote 127.0.0.1 1194\n<ca>\nPEM\n</ca>\n',
    );
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('config_refused_target');
    expect(r.detail).toContain('private, loopback, link-local, or metadata address');
  });

  it('VACUITY CONTROL — the same WireGuard fixture with a PUBLIC endpoint resolves, with no reason at all', async () => {
    // Without this, a service that returned `config_refused_target` for every
    // WireGuard row would pass the arm above.
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedWireguard(repo, HEALTHY_WG);
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_A,
      tier: 'api_builder',
    });
    expect(r.reason).toBeUndefined();
    expect(r.detail).toBeUndefined();
    expect(r.config).toMatchObject({ type: 'wireguard', endpoint: 'vpn.example.com:51820' });
  });

  it('the cross-account read is `not_found`, NOT a decrypt failure — the repo refuses before any key is touched', async () => {
    // The property the mislabelled leg above was actually measuring. It is real
    // and worth pinning; it is just not the GCM case.
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seedOpenvpn(repo, ACCT_A, CLEAN_OVPN);
    const r = await svc.resolveForDispatchWithReason({
      proxyId: row.id,
      accountId: ACCT_B,
      tier: 'api_builder',
    });
    expect(r.config).toBeNull();
    expect(r.reason).toBe('not_found');
    expect(r.detail).toContain('no longer on your account');
  });
});
