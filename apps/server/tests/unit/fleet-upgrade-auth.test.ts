// Increment-2 — unit tests for authenticateFleetUpgrade: the /v1/fleet/events
// WS-upgrade auth gate. Pins: valid JWT + matching node-id header → nodeId;
// missing/malformed bearer → 401; verify failure → UNIFORM 401 (anti-
// enumeration — the FleetJwtVerifyError reason is never surfaced); node-id
// header absent / mismatched / array → 401.

import { describe, expect, it } from 'vitest';
import {
  authenticateFleetUpgrade,
  FLEET_NODE_ID_HEADER,
} from '../../src/services/fleet-upgrade-auth.js';
import { UnauthorizedError } from '../../src/lib/errors.js';
import type {
  FleetNodeAuth,
  FleetJwtVerifyResult,
  FleetJwtVerifyError,
} from '../../src/services/fleet-node-auth.js';

const NODE_ID = '00000000-0000-4000-8000-00000000abcd';

function authThatReturns(result: FleetJwtVerifyResult): FleetNodeAuth {
  return { verify: () => Promise.resolve(result) };
}
function okAuth(iss = NODE_ID): FleetNodeAuth {
  return authThatReturns({
    ok: true,
    claims: { iss, sub: iss, iat: 1, exp: 2, nonce: 'n' },
  });
}
function failAuth(reason: FleetJwtVerifyError): FleetNodeAuth {
  return authThatReturns({ ok: false, reason });
}

function headers(
  jwt: string | undefined,
  nodeId: string | string[] | undefined,
): Record<string, string | string[] | undefined> {
  const h: Record<string, string | string[] | undefined> = {};
  if (jwt !== undefined) h.authorization = `Bearer ${jwt}`;
  if (nodeId !== undefined) h[FLEET_NODE_ID_HEADER] = nodeId;
  return h;
}

describe('authenticateFleetUpgrade', () => {
  it('valid JWT + matching node-id header → resolves the nodeId', async () => {
    const r = await authenticateFleetUpgrade(headers('jwt', NODE_ID), {}, { auth: okAuth() });
    expect(r).toEqual({ nodeId: NODE_ID });
  });

  it('missing Authorization header → 401', async () => {
    await expect(
      authenticateFleetUpgrade(headers(undefined, NODE_ID), {}, { auth: okAuth() }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('malformed Authorization (not Bearer) → 401', async () => {
    await expect(
      authenticateFleetUpgrade(
        { authorization: 'Basic abc', [FLEET_NODE_ID_HEADER]: NODE_ID },
        {},
        {
          auth: okAuth(),
        },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('verify failure → UNIFORM 401 (same message for every reason; the reason is never surfaced)', async () => {
    const reasons: FleetJwtVerifyError[] = [
      'unknown_node',
      'revoked_node',
      'signature_invalid',
      'expired',
      'too_long_lived',
      'replayed_nonce',
      'iss_sub_mismatch',
      'malformed',
    ];
    const messages = new Set<string>();
    for (const reason of reasons) {
      const err = await authenticateFleetUpgrade(
        headers('jwt', NODE_ID),
        {},
        {
          auth: failAuth(reason),
        },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnauthorizedError);
      const msg = (err as Error).message;
      messages.add(msg);
      // anti-enumeration: the specific reason must NOT leak into the message.
      expect(msg.toLowerCase()).not.toContain(reason.replace(/_/g, ' '));
      expect(msg).not.toContain(reason);
    }
    expect(messages.size).toBe(1); // every reason → the identical generic message
  });

  it('node-id header absent → 401 (even with a valid JWT)', async () => {
    await expect(
      authenticateFleetUpgrade(headers('jwt', undefined), {}, { auth: okAuth() }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('node-id header that does not match the JWT iss → 401', async () => {
    await expect(
      authenticateFleetUpgrade(headers('jwt', 'some-other-node'), {}, { auth: okAuth(NODE_ID) }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('node-id header as an array (duplicate header) → 401 (not treated as a valid id)', async () => {
    await expect(
      authenticateFleetUpgrade(headers('jwt', [NODE_ID, NODE_ID]), {}, { auth: okAuth() }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // URLSessionWebSocketTask (the Mac harness daemon) strips the reserved
  // Authorization header on the WS upgrade, so the token + node-id fall back to
  // ?ds_token= / ?node_id= query params (verified against the live box, W2206).
  it('token via ?ds_token query param (no Authorization header) + node-id header → resolves', async () => {
    const r = await authenticateFleetUpgrade(
      headers(undefined, NODE_ID),
      { ds_token: 'jwt' },
      { auth: okAuth() },
    );
    expect(r).toEqual({ nodeId: NODE_ID });
  });

  it('token + node-id BOTH via query (the full no-header URLSession path) → resolves', async () => {
    const r = await authenticateFleetUpgrade(
      {},
      { ds_token: 'jwt', node_id: NODE_ID },
      { auth: okAuth() },
    );
    expect(r).toEqual({ nodeId: NODE_ID });
  });

  it('no token in header OR query → 401', async () => {
    await expect(
      authenticateFleetUpgrade(headers(undefined, NODE_ID), {}, { auth: okAuth() }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
