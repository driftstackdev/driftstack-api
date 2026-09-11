// (n) N15 — POST /v1/account/me/proxies/:id/test?vantage=fleet on a WireGuard row
// whose tunnel FAILS TO COME UP on the fleet Mac.
//
// The node wraps a VPN probe's bring-up in `withVPNEgress`; its catch tears the
// tunnel down and answers `probeEgressRefusal(error: <token>)` — a frame with
// `error !== null`, which the correlator maps to `{status:'error', message:<token>}`.
// A wrong key, a wrong PSK, a dead/UDP-filtered endpoint, `wg setconf failed` and
// the anti-leak check ALL arrive that way. Before this fix the route read every
// non-busy node error as `not_run:'node_error'` — "the test could not be completed
// on the measuring Mac; try again shortly" — so:
//   * the row kept its last GREEN verdict and its stale exit / timezone,
//   * `exit_superseded_at` was never stamped (only the verdict path stamps), and
//   * retrying produced the identical sentence forever.
// A customer with a broken WireGuard config was told to blame the fleet.
//
// GUARD REASONING (the mutation each arm catches, named at the production line):
//   * Revert `classifyVpnProbeFailure` to `const busy = /node_busy/i.test(...)`
//     in apps/server/src/routes/account-me.ts (the dispatch-error VPN branch) and
//     the three VERDICT arms below go red three ways at once: `not_run` comes back
//     as 'node_error' (asserted ABSENT), the reason reverts to "could not be
//     completed on the measuring Mac" (asserted to name the tunnel), and
//     `exit_superseded_at` stays null (asserted set).
//   * Delete ONLY the `proxiesRepo.update({ exitSupersededAt })` block and the
//     first arm's stamp assertion reds while its `not_run`/reason assertions stay
//     green — so the stamp is pinned independently of the classification.
//   * Move `handshake_failed` out of the verdict set (into the residual) and the
//     handshake arm reds while the `node_busy` CONTROL stays green.
//   * The CONTROLS are the vacuity half: `node_busy` and an UNKNOWN token must
//     keep `not_run` and must NOT stamp. A classifier that called everything a
//     verdict would pass every CRITICAL arm and red both controls.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { FleetControlConnection } from '../../src/services/fleet-control-registry.js';

const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
const OBSERVED_AT = new Date('2026-09-01T00:00:00Z');

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (): { authorization: string } => ({ authorization: `Bearer ${fx.plaintext}` });

/** The control plane never measures a VPN row — this stub exists only so the
 *  route's cp dependency is present; a call to it would itself be the bug. */
const cpProbeStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () => Promise.resolve({ observed: false, reason: 'no SYN recorded' }),
  }) as unknown as never;

/** ONE node per app (fleet integration rule). It answers every probeEgress with a
 *  `could_not_run` frame carrying `token` in `error` — the exact shape
 *  `probeEgressRefusal` produces after `withVPNEgress` tears a failed tunnel down.
 *  `afterMs > 0` makes it answer LATE, which is how the node really behaves: it
 *  waits out the tunnel's init window before it can say the tunnel is down. */
function registerRefusingNode(nodeId: string, token: string, afterMs = 0): void {
  const conn: FleetControlConnection = fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as { type: string; requestId: string };
    if (f.type !== 'probeEgress') return;
    const reply = (): void =>
      conn.handleInbound(
        JSON.stringify({
          type: 'probeEgressResult',
          requestId: f.requestId,
          node_id: nodeId,
          ok: false,
          status: 'could_not_run',
          reachable: false,
          auth_ok: false,
          udp_associate: false,
          can_route: false,
          latency_ms: null,
          h2_ok: false,
          quic_ok: false,
          quic_detail: null,
          exit_ip: null,
          error: token,
        }),
      );
    if (afterMs === 0) reply();
    else setTimeout(reply, afterMs);
  });
}

async function makeWireGuardProxy(): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(), 'content-type': 'application/json' },
    payload: {
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
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

/** Give the row a GREEN stored exit, so a run that stamps `exit_superseded_at`
 *  is distinguishable from one that leaves the row untouched. */
async function seedGreenExit(id: string): Promise<void> {
  await fx.accountProxiesRepo.update({
    id,
    accountId: fx.accountId,
    updates: {
      exitObserved: {
        ip: '203.0.113.9',
        country: 'NL',
        timezone: 'Europe/Amsterdam',
        observed_via: 'probe',
      },
      exitObservedAt: OBSERVED_AT,
      exitSupersededAt: null,
    },
  });
}

async function supersededAt(id: string): Promise<Date | null> {
  const row = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
  expect(row, 'the proxy row must still exist').not.toBeNull();
  return row?.exitSupersededAt ?? null;
}

/** One app, one node, one WireGuard row, one fleet test. */
async function runFleetTest(
  nodeId: string,
  token: string,
): Promise<{ body: Record<string, unknown>; proxyId: string }> {
  fx = await buildTestApp({
    enableFleetControlPlane: true,
    proxyConnectivityProbe: cpProbeStub(),
  });
  registerRefusingNode(nodeId, token);
  const proxyId = await makeWireGuardProxy();
  await seedGreenExit(proxyId);
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/account/me/proxies/${proxyId}/test?vantage=fleet`,
    headers: auth(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.json<Record<string, unknown>>(), proxyId };
}

describe('a WireGuard tunnel the fleet Mac could not bring up is a VERDICT, not "try again shortly"', () => {
  it('CRITICAL handshake_failed → ok:false, NO not_run, a reason naming the tunnel, and exit_superseded_at stamped', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-001', 'handshake_failed');

    expect(body.ok).toBe(false);
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-wg-001');
    // ⛔ The whole point: a client branches on `not_run`, and its ABSENCE is what
    // turns this into the red "tunnel down" instead of a grey "try again" notice.
    expect('not_run' in body, 'a failed bring-up is a verdict — not_run must be ABSENT').toBe(
      false,
    );
    expect(body.reason).toMatch(/WireGuard tunnel did not come up/);
    // The old sentence must be gone, not merely joined.
    expect(body.reason).not.toMatch(/could not be completed on the measuring Mac/);
    // The stored exit is CONTRADICTED now: the tunnel behind it was found down.
    expect(await supersededAt(proxyId), 'exit_superseded_at must be stamped').not.toBeNull();
  });

  it('CRITICAL endpoint_unreachable → a verdict that says the endpoint did not answer, and NEVER "check your address"', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-002', 'endpoint_unreachable');

    expect(body.ok).toBe(false);
    expect('not_run' in body).toBe(false);
    expect(body.reason).toMatch(/did not answer within the tunnel's wait/);
    // ⛔ From the node a WRONG endpoint and a DOWN endpoint are indistinguishable,
    // so the copy must never send the customer to edit a line that may be correct.
    expect(String(body.reason)).not.toMatch(/check your address/i);
    expect(await supersededAt(proxyId)).not.toBeNull();
  });

  it('CRITICAL egress_leak_detected → a verdict naming the leak (never a pass, never a not_run)', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-003', 'egress_leak_detected');

    expect(body.ok).toBe(false);
    expect('not_run' in body).toBe(false);
    expect(body.reason).toMatch(/did not leave through it/);
    expect(await supersededAt(proxyId)).not.toBeNull();
  });

  it('CONTROL node_busy keeps not_run:node_busy and stamps NOTHING (a wait is not a verdict)', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-004', 'node_busy');

    expect(body.ok).toBe(false);
    expect(body.not_run).toBe('node_busy');
    expect(body.reason).toMatch(/busy with another tunnel or test/);
    expect(await supersededAt(proxyId), 'a busy Mac contradicts no exit').toBeNull();
  });

  it('CONTROL an UNKNOWN token (a node newer than this build) stays the residual not_run:node_error and stamps NOTHING', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-005', 'some_future_token_v9');

    expect(body.ok).toBe(false);
    expect(body.not_run).toBe('node_error');
    expect(body.reason).toMatch(/could not be completed on the measuring Mac/);
    // ⛔ Guessing "tunnel down" from a word this build cannot read would publish a
    // red verdict nothing measured — and supersede an exit on a guess.
    expect(await supersededAt(proxyId)).toBeNull();
  });

  it('CONTROL egress_bin_missing is OUR fault: not_run:node_error, copy that owns it, no stamp', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-006', 'egress_bin_missing');

    expect(body.not_run).toBe('node_error');
    expect(body.reason).toMatch(/test Mac could not start its VPN tool/);
    expect(body.reason).toMatch(/fault on our side/);
    // Never blame the customer's config for a binary missing on OUR Mac.
    expect(String(body.reason)).not.toMatch(/check the keys/i);
    expect(await supersededAt(proxyId)).toBeNull();
  });

  it('CONTROL tunnel_up_no_socks is OUR fault too (the tunnel DID come up — never a tunnel-down verdict)', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-007', 'tunnel_up_no_socks');

    expect(body.not_run).toBe('node_error');
    expect(body.reason).toMatch(/test Mac could not start its VPN tool/);
    expect(await supersededAt(proxyId)).toBeNull();
  });

  it('(n) N16 ROUTE HALF — a node that answers at t=20 s is still HEARD: the reply is the tunnel verdict, never not_run:"no_node"', async () => {
    // ⛔ This is the pair of findings landing on one line. N16: the correlator's
    // flat 15 s wait expired before a WireGuard bring-up could fail, `settle`
    // dropped the node's late frame, and the route turned the timeout into
    // `not_run:'no_node'` — "No fleet Mac was free to test this VPN tunnel." N15:
    // even when the frame DID arrive it was read as `node_error`. With both fixed
    // the customer finally learns their tunnel is down.
    //
    // Mutation: restore `timeoutMs = PROBE_EGRESS_REQUEST_TIMEOUT_MS` as the
    // correlator's default and this arm reds on `not_run` being 'no_node' plus the
    // "No fleet Mac was free" sentence — the exact pair the owner reported.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // The node takes 20 s to answer, as a real one does: the utun wait plus the
    // handshake poll run past 20 s before `handshake_failed` is even thrown.
    registerRefusingNode('mac-wg-009', 'handshake_failed', 20_000);
    const proxyId = await makeWireGuardProxy();
    await seedGreenExit(proxyId);

    vi.useFakeTimers();
    try {
      const pending = fx.app.inject({
        method: 'POST',
        url: `/v1/account/me/proxies/${proxyId}/test?vantage=fleet`,
        headers: auth(),
      });
      await vi.advanceTimersByTimeAsync(20_000);
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<Record<string, unknown>>();

      expect(body.not_run, 'the late answer must not be reported as "no Mac was free"').not.toBe(
        'no_node',
      );
      expect(String(body.reason)).not.toMatch(/No fleet Mac was free/);
      // …and it is the verdict, with the node named as its source.
      expect(body.ok).toBe(false);
      expect(body.measured_from).toBe('fleet');
      expect(body.node_id).toBe('mac-wg-009');
      expect('not_run' in body).toBe(false);
      expect(body.reason).toMatch(/WireGuard tunnel did not come up/);
    } finally {
      vi.useRealTimers();
    }
    expect(await supersededAt(proxyId)).not.toBeNull();
  });

  it('CONTROL bad_config:<field> keeps the residual sentence and not_run:node_error (unchanged by this fix)', async () => {
    const { body, proxyId } = await runFleetTest('mac-wg-008', 'bad_config:private_key');

    expect(body.not_run).toBe('node_error');
    expect(body.reason).toMatch(/could not be completed on the measuring Mac/);
    // The wire field name is jargon — it must never reach the customer.
    expect(String(body.reason)).not.toMatch(/private_key/);
    expect(await supersededAt(proxyId)).toBeNull();
  });
});
