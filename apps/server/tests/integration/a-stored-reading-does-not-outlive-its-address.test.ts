// ITEM 2 — a reading must not survive a change of address.
//
// PUT /v1/account/me/proxies/:id can repoint a row at a different machine. The
// readings it carries — the passive OS fingerprint, the exit identity (+ the
// stamp dating its contradiction) and the measured QUIC verdict — were all
// taken by connecting THROUGH the old one, and (now that the list surfaces
// them) a customer who repoints a proxy would otherwise SEE a reading of a
// server they no longer use.
//
// These arms pin the rule in `proxyReadingsInvalidatedByEdit`:
//   · host / port / scheme  → every reading goes, in ONE update statement
//   · the VPN block's identity material (the .ovpn blob, the OpenVPN account
//     inside it, the WireGuard keys / endpoint) → every reading goes too. For a
//     VPN row host and port are DERIVED from the conf's endpoint and the
//     top-level username/password are null, so a provider key rotation moves
//     none of the fields above — the hole the desktop client had already fixed
//     on its side (`vpnMaterialChanged` in ProxiesView)
//   · username / password → what was measured inside the authenticated session
//     goes (exit identity, QUIC, an OS reading OF THE EXIT); the front door's
//     own OS reading stays — no credential moves the machine at an unchanged
//     host:port. A password rotation from one string to ANOTHER counts: both
//     sides are decrypted and compared, because a ciphertext comparison answers
//     the wrong question and a presence comparison answers none
//   · label → nothing goes, and a repointed row's stale background-failure
//     streak goes with the readings, so the row is re-measured in minutes
//   · and the routine full-body resync the desktop client PUTs before EVERY
//     launch (same host/port/username/password, same VPN block) changes nothing,
//     which is why the rule compares stored VALUES and never key presence.
//
// The invalidation is unconditional: this route never probes, so a reading is
// dropped whether or not the new address answers. A reading we cannot replace
// is not a reading we may keep.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { AccountProxyRow, AccountProxyRowUpdates } from '../../src/db/account-proxies-repo.js';

/** The stored measurement shape, so an `exit_ip` and a `proxy_host` reading are
 *  the same type at every call site below. */
type StoredOsReading = NonNullable<AccountProxyRow['osFingerprint']>;

let fx: TestAppFixture;
afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

const MEASURED_AT = new Date('2026-09-16T10:00:00.000Z');
const SUPERSEDED_AT = new Date('2026-09-16T10:05:00.000Z');
/** The last time the BACKGROUND sweep attempted this row (migration 0123). */
const ATTEMPTED_AT = new Date('2026-09-16T09:00:00.000Z');

/** A minimal valid client .ovpn — a `client` line and a `remote` line is all the
 *  schema requires, and the blob is stored as the identity material it is. */
const OVPN_BLOB = 'client\nremote vpn.example.com 1194 udp\ndev tun\n';
const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
/** The same key with one character changed: a provider key rotation, not a typo
 *  the schema would reject. */
const WG_PRIV_ROTATED = 'zAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const exitOsReading: StoredOsReading = {
  os: 'linux',
  confidence: 'high',
  reason: 'Based on how this proxy responds to a network connection.',
  observed_ip: '198.51.100.7',
  observed_via: 'exit_ip',
};
const frontDoorOsReading: StoredOsReading = { ...exitOsReading, observed_via: 'proxy_host' };

/** Every stored reading a row can carry, as a test + a live session would have
 *  left them. One declaration, so a socks5 row and a VPN row are seeded with the
 *  same set and an arm cannot pass because its row was seeded thinner. */
const everyReading = (osFingerprint: StoredOsReading): AccountProxyRowUpdates => ({
  osFingerprint,
  osFingerprintAt: MEASURED_AT,
  exitObserved: {
    ip: '198.51.100.7',
    country: 'US',
    timezone: 'America/New_York',
    observed_via: 'probe',
  },
  exitObservedAt: MEASURED_AT,
  exitSupersededAt: SUPERSEDED_AT,
  quicMeasured: 'h3',
  quicMeasuredAt: MEASURED_AT,
});

/** Create a proxy and put every stored reading on it, as a test + a live
 *  session would have. Returns its id. */
async function proxyWithEveryReading(
  overrides: { username?: string | null; password?: string | null } = {},
  osFingerprint: StoredOsReading = exitOsReading,
): Promise<string> {
  const created = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: {
      label: 'residential',
      host: 'gw.example.com',
      port: 1080,
      username: overrides.username ?? 'user-country-us',
      password: overrides.password ?? 'pw-one',
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ id: string }>().id;
  await fx.accountProxiesRepo.update({
    id,
    accountId: fx.accountId,
    updates: everyReading(osFingerprint),
  });
  return id;
}

/** The same seeding for a VPN row, which is created through its own body. A VPN
 *  row's `exit_observed` is the ONLY source of its country and timezone, so a
 *  stale one is not cosmetic. */
async function vpnProxyWithEveryReading(
  payload: Record<string, unknown>,
  osFingerprint: StoredOsReading,
): Promise<string> {
  const created = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload,
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  await fx.accountProxiesRepo.update({
    id,
    accountId: fx.accountId,
    updates: everyReading(osFingerprint),
  });
  return id;
}

const putProxy = (id: string, payload: Record<string, unknown>) =>
  fx.app.inject({
    method: 'PUT',
    url: `/v1/account/me/proxies/${id}`,
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload,
  });

describe('PUT /v1/account/me/proxies/:id — a stored reading does not outlive its address', () => {
  it('a port change clears EVERY stored reading, in the same single UPDATE that moves the row', async () => {
    fx = await buildTestApp();
    const id = await proxyWithEveryReading();
    // Spy only now: the seeding above is not the write under test.
    const update = vi.spyOn(fx.accountProxiesRepo, 'update');

    const res = await putProxy(id, { port: 1081 });
    expect(res.statusCode).toBe(200);

    // ONE statement — not a repoint followed by a second round-trip that can
    // fail after the first landed, leaving the row half-invalidated.
    expect(update).toHaveBeenCalledTimes(1);
    const updates = update.mock.calls[0]?.[0].updates as AccountProxyRowUpdates;
    expect(updates.port).toBe(1081);
    expect(updates).toMatchObject({
      osFingerprint: null,
      osFingerprintAt: null,
      exitObserved: null,
      exitObservedAt: null,
      exitSupersededAt: null,
      quicMeasured: null,
      quicMeasuredAt: null,
    });

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.port).toBe(1081);
    expect(row?.osFingerprint).toBeNull();
    expect(row?.osFingerprintAt).toBeNull();
    expect(row?.exitObserved).toBeNull();
    expect(row?.exitObservedAt).toBeNull();
    expect(row?.exitSupersededAt).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    expect(row?.quicMeasuredAt).toBeNull();
  });

  it('a host change clears every stored reading too — and a scheme change, same machine or not', async () => {
    fx = await buildTestApp();
    const moved = await proxyWithEveryReading();
    expect((await putProxy(moved, { host: 'gw2.example.com' })).statusCode).toBe(200);
    const movedRow = await fx.accountProxiesRepo.findById({ id: moved, accountId: fx.accountId });
    expect(movedRow?.osFingerprint).toBeNull();
    expect(movedRow?.exitObserved).toBeNull();
    expect(movedRow?.quicMeasured).toBeNull();

    // A different service answering on the same host:port is a different
    // machine as far as every reading is concerned.
    const reschemed = await proxyWithEveryReading();
    expect((await putProxy(reschemed, { scheme: 'http' })).statusCode).toBe(200);
    const reschemedRow = await fx.accountProxiesRepo.findById({
      id: reschemed,
      accountId: fx.accountId,
    });
    expect(reschemedRow?.scheme).toBe('http');
    expect(reschemedRow?.osFingerprint).toBeNull();
    expect(reschemedRow?.osFingerprintAt).toBeNull();
    expect(reschemedRow?.exitObserved).toBeNull();
    expect(reschemedRow?.exitSupersededAt).toBeNull();
    expect(reschemedRow?.quicMeasured).toBeNull();
  });

  it('a label-only edit clears NOTHING — the machine, the identity and every reading are unchanged', async () => {
    fx = await buildTestApp();
    const id = await proxyWithEveryReading();

    expect((await putProxy(id, { label: 'work laptop' })).statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.label).toBe('work laptop');
    expect(row?.osFingerprint).toEqual(exitOsReading);
    expect(row?.osFingerprintAt).toEqual(MEASURED_AT);
    expect(row?.exitObserved).toMatchObject({ ip: '198.51.100.7', country: 'US' });
    expect(row?.exitObservedAt).toEqual(MEASURED_AT);
    expect(row?.exitSupersededAt).toEqual(SUPERSEDED_AT);
    expect(row?.quicMeasured).toBe('h3');
    expect(row?.quicMeasuredAt).toEqual(MEASURED_AT);
  });

  it('the desktop client’s per-launch resync — every field resubmitted UNCHANGED — clears nothing', async () => {
    // ensureAccountProxyRow() PUTs the whole proxy (label, scheme, host, port,
    // username, password) before every launch and every Test. If the rule read
    // key PRESENCE instead of the stored value, every launch would wipe the
    // readings it exists to preserve.
    fx = await buildTestApp();
    const id = await proxyWithEveryReading();

    const res = await putProxy(id, {
      label: 'residential',
      scheme: 'socks5',
      host: 'gw.example.com',
      port: 1080,
      username: 'user-country-us',
      password: 'pw-one',
    });
    expect(res.statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.osFingerprint).toEqual(exitOsReading);
    expect(row?.exitObserved).toMatchObject({ ip: '198.51.100.7' });
    expect(row?.exitObservedAt).toEqual(MEASURED_AT);
    expect(row?.exitSupersededAt).toEqual(SUPERSEDED_AT);
    expect(row?.quicMeasured).toBe('h3');
    expect(row?.quicMeasuredAt).toEqual(MEASURED_AT);
  });

  it('a username change drops what the authenticated session measured, and an OS reading OF THE EXIT', async () => {
    // The username is the exit selector on a rotating-residential gateway, and
    // an `exit_ip` fingerprint is a reading of the exit it selected.
    fx = await buildTestApp();
    const id = await proxyWithEveryReading({}, exitOsReading);

    expect((await putProxy(id, { username: 'user-country-de' })).statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.username).toBe('user-country-de');
    expect(row?.host).toBe('gw.example.com');
    expect(row?.exitObserved).toBeNull();
    expect(row?.exitObservedAt).toBeNull();
    expect(row?.exitSupersededAt).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    expect(row?.quicMeasuredAt).toBeNull();
    expect(row?.osFingerprint).toBeNull();
    expect(row?.osFingerprintAt).toBeNull();
  });

  it('a credential change KEEPS the front door’s own OS reading — no credential moves the machine at an unchanged host:port', async () => {
    fx = await buildTestApp();
    const id = await proxyWithEveryReading({}, frontDoorOsReading);

    // Removing the password is a credential change this boundary can see (the
    // stored envelope is write-only, so a string→string rotation is not).
    expect((await putProxy(id, { password: null })).statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.wrappedPassword).toBeNull();
    // Measured through the authenticated session → gone.
    expect(row?.exitObserved).toBeNull();
    expect(row?.exitSupersededAt).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    // Measured OF the front door at an unchanged address → kept.
    expect(row?.osFingerprint).toEqual(frontDoorOsReading);
    expect(row?.osFingerprintAt).toEqual(MEASURED_AT);
  });

  it('invalidates even when the new address is unreachable — the PUT never probes at all', async () => {
    // We must not keep a reading because the replacement probe failed: that is
    // exactly the row whose stale reading would stand forever.
    const probeCalls: string[] = [];
    fx = await buildTestApp({
      proxyConnectivityProbe: {
        probe: () => {
          probeCalls.push('probe');
          return Promise.resolve({ ok: false, reason: 'unreachable' });
        },
        observeOs: () => {
          probeCalls.push('observeOs');
          return Promise.resolve({ observed: false, reason: 'no SYN recorded' });
        },
      } as unknown as never,
      proxyTcpProbe: (host: string, port: number) => {
        probeCalls.push(`tcp:${host}:${port.toString()}`);
        return Promise.reject(new Error('connect ECONNREFUSED'));
      },
    });
    const id = await proxyWithEveryReading();

    const res = await putProxy(id, { host: 'blackhole.example.com', port: 9999 });
    expect(res.statusCode).toBe(200);

    expect(probeCalls).toEqual([]);
    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.host).toBe('blackhole.example.com');
    expect(row?.osFingerprint).toBeNull();
    expect(row?.exitObserved).toBeNull();
    expect(row?.exitObservedAt).toBeNull();
    expect(row?.exitSupersededAt).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    expect(row?.quicMeasuredAt).toBeNull();
  });

  it('a password ROTATION at the same address is a credential edit — the stored envelope is DECRYPTED and compared, not weighed by its presence', async () => {
    // The rule used to be able to see a password only when one was ADDED or
    // REMOVED, and the residual was excused as "caught client-side". It is not:
    // the client deletes its cache entry, then re-seeds it from THIS row on the
    // next list refresh (`adoptListOsFingerprint`). So the comparison is made
    // here, against the decrypted value.
    fx = await buildTestApp();
    const id = await proxyWithEveryReading({ password: 'pw-one' }, frontDoorOsReading);

    expect((await putProxy(id, { password: 'pw-two' })).statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.wrappedPassword, 'the new password is stored').not.toBeNull();
    // Measured inside a session authenticated with the OLD password.
    expect(row?.exitObserved).toBeNull();
    expect(row?.exitObservedAt).toBeNull();
    expect(row?.exitSupersededAt).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    expect(row?.quicMeasuredAt).toBeNull();
    // Still the front door's own stack at an unchanged host:port.
    expect(row?.osFingerprint).toEqual(frontDoorOsReading);
    expect(row?.osFingerprintAt).toEqual(MEASURED_AT);
  });

  it('an OpenVPN ACCOUNT SWITCH at the same server clears every reading — the VPN block is identity material, and none of host/port/scheme/username/password moves when it changes', async () => {
    // The hole this arm exists for: for a VPN row the display host and port are
    // DERIVED from the conf's endpoint and the top-level username/password are
    // structurally null, so a provider account switch — or a re-pasted conf with
    // new keys — moved NOTHING the old rule compared. The row kept the exit
    // measured through the previous provider account, and for a VPN row
    // `exit_observed` is the only source of its country and timezone.
    fx = await buildTestApp();
    const id = await vpnProxyWithEveryReading(
      {
        label: 'provider',
        scheme: 'openvpn',
        host: 'vpn.example.com',
        port: 1194,
        openvpn: { config_blob: OVPN_BLOB, username: 'acct-A', password: 'key-A' },
      },
      exitOsReading,
    );

    const res = await putProxy(id, {
      scheme: 'openvpn',
      host: 'vpn.example.com',
      port: 1194,
      openvpn: { config_blob: OVPN_BLOB, username: 'acct-B', password: 'key-A' },
    });
    expect(res.statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.host, 'the machine the row names did not move — that is the point').toBe(
      'vpn.example.com',
    );
    expect(row?.exitObserved).toBeNull();
    expect(row?.exitObservedAt).toBeNull();
    expect(row?.exitSupersededAt).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    expect(row?.quicMeasuredAt).toBeNull();
    expect(row?.osFingerprint).toBeNull();
    expect(row?.osFingerprintAt).toBeNull();
  });

  it('a WireGuard KEY ROTATION at an unchanged endpoint clears every reading, including a front-door OS reading: VPN material takes the MACHINE arm, because the tunnel endpoint lives INSIDE it', async () => {
    // `remote` is a line in the .ovpn blob and the endpoint is a field in the
    // WireGuard block, so "same server, new keys" and "new server" are the same
    // edit at this boundary. The cautious reading of an ambiguous change is that
    // the machine moved — which is why this asserts the 'proxy_host' reading a
    // credential edit would have KEPT is gone.
    fx = await buildTestApp();
    const id = await vpnProxyWithEveryReading(
      {
        label: 'wg',
        scheme: 'wireguard',
        host: 'vpn.example.com',
        port: 51820,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
          address: '10.7.0.2/32',
        },
      },
      frontDoorOsReading,
    );

    const res = await putProxy(id, {
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      wireguard: {
        private_key: WG_PRIV_ROTATED,
        peer_public_key: WG_PUB,
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.exitObserved).toBeNull();
    expect(row?.quicMeasured).toBeNull();
    expect(row?.osFingerprint, 'the machine arm, not the credential one').toBeNull();
    expect(row?.osFingerprintAt).toBeNull();
  });

  it('the per-launch resync of a VPN row — the identical block, host and port — clears NOTHING, so the VPN rule cannot be presence-based and cannot compare ciphertext', async () => {
    // Two ways to get this wrong, both red here: clearing because a VPN block
    // arrived (the client sends one before every launch), and comparing the
    // stored envelope, which is AEAD over a random nonce and therefore differs
    // from itself on every write.
    fx = await buildTestApp();
    const id = await vpnProxyWithEveryReading(
      {
        label: 'provider',
        scheme: 'openvpn',
        host: 'vpn.example.com',
        port: 1194,
        openvpn: { config_blob: OVPN_BLOB, username: 'acct-A', password: 'key-A' },
      },
      exitOsReading,
    );

    const res = await putProxy(id, {
      scheme: 'openvpn',
      host: 'vpn.example.com',
      port: 1194,
      openvpn: { config_blob: OVPN_BLOB, username: 'acct-A', password: 'key-A' },
    });
    expect(res.statusCode).toBe(200);

    const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(row?.osFingerprint).toEqual(exitOsReading);
    expect(row?.osFingerprintAt).toEqual(MEASURED_AT);
    expect(row?.exitObserved).toMatchObject({ ip: '198.51.100.7' });
    expect(row?.exitObservedAt).toEqual(MEASURED_AT);
    expect(row?.exitSupersededAt).toEqual(SUPERSEDED_AT);
    expect(row?.quicMeasured).toBe('h3');
  });

  it('a repointed row does not inherit the OLD address’s failure streak — it is due for a background refresh at once, so the columns this PUT cleared are re-measured in minutes, not a day', async () => {
    // `freshness_consecutive_failures` is a property of the machine we could not
    // reach. It drives a linear backoff up to 24h, so a proxy that was switched
    // off long enough to condemn its exit and is then REPOINTED at a working
    // server would otherwise sit blank for a day — the customer's fix producing
    // an empty chip instead of a fresh reading.
    fx = await buildTestApp();
    const moved = await proxyWithEveryReading();
    await fx.accountProxiesRepo.update({
      id: moved,
      accountId: fx.accountId,
      updates: { freshnessConsecutiveFailures: 3, freshnessAttemptedAt: ATTEMPTED_AT },
    });

    expect((await putProxy(moved, { host: 'gw2.example.com' })).statusCode).toBe(200);
    const movedRow = await fx.accountProxiesRepo.findById({ id: moved, accountId: fx.accountId });
    expect(movedRow?.freshnessConsecutiveFailures).toBe(0);
    expect(movedRow?.freshnessAttemptedAt, 'null = due on the next sweep tick').toBeNull();

    // A label edit is not a new address: the streak and the cooldown stand, or a
    // rename would schedule a dial through the customer's proxy.
    const renamed = await proxyWithEveryReading();
    await fx.accountProxiesRepo.update({
      id: renamed,
      accountId: fx.accountId,
      updates: { freshnessConsecutiveFailures: 2, freshnessAttemptedAt: ATTEMPTED_AT },
    });
    expect((await putProxy(renamed, { label: 'renamed' })).statusCode).toBe(200);
    const renamedRow = await fx.accountProxiesRepo.findById({
      id: renamed,
      accountId: fx.accountId,
    });
    expect(renamedRow?.freshnessConsecutiveFailures).toBe(2);
    expect(renamedRow?.freshnessAttemptedAt).toEqual(ATTEMPTED_AT);
  });

  it('a fingerprint measured during a test that the customer repointed MIDWAY is not stored — the /test route fences its write on the identity it measured through, exactly as the background sweep does', async () => {
    // The probe holds the row for ~12 seconds. A PUT in that window clears these
    // columns and moves the row; a write landing after it would restore a reading
    // of the PREVIOUS address, dated now, onto the row the customer just fixed —
    // and no staleness tie-break can catch that, because the invalidation nulls
    // the timestamps it would compare.
    let repointed: string | null = null;
    fx = await buildTestApp({
      proxyConnectivityProbe: {
        probe: () => Promise.resolve({ ok: true }),
        observeOs: async () => {
          if (repointed !== null) {
            await fx.accountProxiesRepo.update({
              id: repointed,
              accountId: fx.accountId,
              updates: { host: 'moved.example.com', osFingerprint: null, osFingerprintAt: null },
            });
          }
          return {
            observed: true,
            os: 'linux',
            confidence: 'high',
            reason: 'ttl 64, mss 1460',
            observedIp: '198.51.100.7',
            via: 'proxy_host',
            singleHostVantage: false,
            webPortVantage: false,
          };
        },
      } as unknown as never,
    });
    repointed = await proxyWithEveryReading();

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${repointed}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    // The reply still carries what THIS test measured — the customer is watching
    // it. What must not happen is it being written onto the moved row.
    expect(res.json<{ os_fingerprint?: { os: string } }>().os_fingerprint?.os).toBe('linux');

    const row = await fx.accountProxiesRepo.findById({
      id: repointed,
      accountId: fx.accountId,
    });
    expect(row?.host).toBe('moved.example.com');
    expect(row?.osFingerprint, 'a reading of the address the row no longer has').toBeNull();
    expect(row?.osFingerprintAt).toBeNull();
  });
});
