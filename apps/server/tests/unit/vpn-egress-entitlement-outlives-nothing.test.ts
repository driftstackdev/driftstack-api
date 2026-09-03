// V-786 — a stored VPN proxy is only usable while the account is still entitled.
//
// `TIER_FEATURES.vpnEgress` is a published claim: `select-tier.astro` paints the
// pricing table's Access column straight from it, and the flag's own comment says
// "`false` on free (SOCKS5 proxy only)". It was enforced where a proxy is
// REGISTERED — `routes/account-me.ts` POST and PUT — and nowhere else.
//
// A stored proxy outlives the tier that was allowed to store it. An account that
// registered an OpenVPN or WireGuard profile while paid and then downgraded to
// free kept egressing through it for as long as the row existed:
// `handleTierChanged` writes an audit row and sends an email, and touches nothing
// in `account_proxies`. Rows created before the registration gate landed were in
// the same position, and neither case ever expires.
//
// The interesting part is why the existing guard could not see it.
// `every-boolean-tier-feature-is-enforced.test.ts` asks whether each flag is
// enforced ANYWHERE, and counts a call site as an answer. `vpnEgress` had two, so
// it read as enforced. But "gated on the path that CREATES the resource" and
// "gated on the path that USES it" are different properties, and only the second
// is what the pricing table promises. Counting call sites cannot tell them apart
// — see the companion case added to that file.
//
// So this asserts the USE path directly, at the choke point that turns a stored
// row into a dispatchable egress config.

import { describe, expect, it } from 'vitest';

import type { AccountProxiesRepo, AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { AccountProxiesService } from '../../src/services/account-proxies.js';
import { ForbiddenError } from '../../src/lib/errors.js';

const MASTER = Buffer.alloc(32, 7);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function rowOf(scheme: AccountProxyRow['scheme']): AccountProxyRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    accountId: ACCOUNT,
    label: 'test',
    scheme,
    host: 'vpn.customer.example',
    port: 1194,
    username: null,
    wrappedPassword: null,
    wrappedSecret: null,
    config: {},
    quicMeasured: null,
    quicMeasuredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const repoReturning = (row: AccountProxyRow | null): AccountProxiesRepo =>
  ({ findById: () => Promise.resolve(row) }) as unknown as AccountProxiesRepo;

describe('V-786 the vpnEgress entitlement is checked when the proxy is USED, not only when it is stored', () => {
  for (const scheme of ['openvpn', 'wireguard'] as const) {
    it(`CRITICAL a free account cannot dispatch through a stored ${scheme} row. This is the downgrade case and it is not hypothetical: registering while paid is allowed, and nothing on the downgrade path deletes or disables the row — handleTierChanged audits and emails without touching account_proxies. Before this the row stayed usable forever.`, async () => {
      const svc = new AccountProxiesService(repoReturning(rowOf(scheme)), MASTER);

      await expect(
        svc.resolveForDispatch({ proxyId: rowOf(scheme).id, accountId: ACCOUNT, tier: 'free' }),
        'refused rather than resolved',
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it(`CRITICAL an entitled account still dispatches through a stored ${scheme} row. The gate must refuse the unentitled without breaking the feature for the tiers that pay for it — a check that fails closed for everyone is not a fix.`, async () => {
      const svc = new AccountProxiesService(repoReturning(rowOf(scheme)), MASTER);

      // Resolution proceeds past the entitlement check; it then fails on the
      // absent secret material rather than on the tier, which is the property
      // under test. A ForbiddenError here would mean the gate caught a paying
      // account.
      await expect(
        svc.resolveForDispatch({
          proxyId: rowOf(scheme).id,
          accountId: ACCOUNT,
          tier: 'api_builder',
        }),
      ).resolves.toBeNull();
    });
  }

  it('CRITICAL a socks5 row is unaffected by the tier. Free keeps its one proxy (PROXIES_PER_TIER.free === 1) and the published claim is specifically about VPN egress — gating socks5 too would take away something free was promised.', async () => {
    const svc = new AccountProxiesService(repoReturning(rowOf('socks5')), MASTER);

    const resolved = await svc.resolveForDispatch({
      proxyId: rowOf('socks5').id,
      accountId: ACCOUNT,
      tier: 'free',
    });
    expect(resolved, 'resolved, not refused').not.toBeNull();
    expect((resolved as { host: string }).host).toBe('vpn.customer.example');
  });

  it('CRITICAL a row that is not found is still a null, not a Forbidden. The owner-scoped miss must stay indistinguishable from "no such proxy" — leaking Forbidden for a foreign id would confirm that another account owns it.', async () => {
    const svc = new AccountProxiesService(repoReturning(null), MASTER);

    await expect(
      svc.resolveForDispatch({ proxyId: rowOf('openvpn').id, accountId: ACCOUNT, tier: 'free' }),
    ).resolves.toBeNull();
  });
});
