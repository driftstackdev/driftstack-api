/* eslint-disable no-console -- one-off operator CLI: the minted uuid must print */
// Fleet-node registration — register a Mac harness node's Ed25519 public key
// (and optionally its LiveKit creds) in `fleet_nodes` so the control plane can
// auth its WSS connection (FleetNodeAuth.getPublicKey lookup) and dispatch
// sessions to it. This is the prod "register the node pubkey" path the
// worker-cp-connect-readiness §2 blocker calls for — environment-driven, so the
// same script seeds local dev OR a real prod node (the only difference is the
// DATABASE_URL + the metadata env vars you pass).
//
// Local dev:
//   DATABASE_URL=postgres://…local… MFA_ENCRYPTION_KEY=<b64-32> \
//   FLEET_NODE_PUBLIC_KEY_BASE64URL=<ed25519 pubkey b64url> \
//   LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret LIVEKIT_WS_URL=ws://localhost:7880 \
//   npx tsx apps/server/src/scripts/seed-local-fleet-node.ts
//
// Prod node (e.g. the MacStadium worker):
//   DATABASE_URL=<prod> MFA_ENCRYPTION_KEY=<prod b64-32> \
//   FLEET_NODE_PUBLIC_KEY_BASE64URL=<the box's ed25519 pubkey, from A3> \
//   FLEET_NODE_DISPLAY_NAME=mac-macstadium-us-001 FLEET_NODE_REGION=us-east-1 \
//   FLEET_NODE_HARDWARE_CLASS=mac-mini-m2pro \
//   [LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… LIVEKIT_WS_URL=…] \
//   npx tsx apps/server/src/scripts/seed-local-fleet-node.ts
//
// LiveKit creds are OPTIONAL: provide all three LIVEKIT_* to set them now, or
// omit them to register identity only (the node can connect + heartbeat without
// LiveKit; set creds later via POST /v1/mac-nodes/register). NO fake dev
// defaults are applied — omitting one of the three skips LiveKit entirely so a
// prod node never gets bogus localhost creds.
//
// IMPORTANT: fleet_nodes.id is a UUID minted by the DB (NOT a caller-chosen
// string). This prints the minted uuid — set DRIFTSTACK_MAC_NODE_ID to it on
// the harness daemon (its JWT iss/sub + X-Driftstack-Mac-Node-Id must equal
// this uuid, else the FleetNodeAuth verifier's getPublicKey(iss) lookup misses).

import { createDb } from '../db/client.js';
import { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import { encryptLivekitSecret } from '../lib/livekit-secret-encryption.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = required('DATABASE_URL');
  // MFA_ENCRYPTION_KEY is the shared LiveKit-secret envelope key (same key the
  // server decrypts with at session-create — see maybeMintLivekit). Only needed
  // when actually setting LiveKit creds, but required up-front to fail fast.
  const encryptionKey = required('MFA_ENCRYPTION_KEY');
  const publicKeyBase64Url = required('FLEET_NODE_PUBLIC_KEY_BASE64URL');
  // Metadata — env-driven so a prod node gets correct display/region/hardware
  // (the admin Fleet panel shows these); local-dev defaults preserved.
  const displayName = process.env.FLEET_NODE_DISPLAY_NAME ?? 'local-mac-dev';
  const region = process.env.FLEET_NODE_REGION ?? 'local';
  const hardwareClass = process.env.FLEET_NODE_HARDWARE_CLASS ?? 'mac-dev';
  // LiveKit only when ALL three are explicitly provided (no fake defaults).
  const livekitApiKey = process.env.LIVEKIT_API_KEY;
  const livekitSecret = process.env.LIVEKIT_API_SECRET;
  const livekitWsUrl = process.env.LIVEKIT_WS_URL;
  const withLivekit =
    livekitApiKey !== undefined && livekitSecret !== undefined && livekitWsUrl !== undefined;

  const database = createDb(databaseUrl, { max: 1 });
  try {
    const repo = new DrizzleFleetNodesRepo(database);
    const node = await repo.register({
      publicKeyBase64Url,
      displayName,
      region,
      hardwareClass,
    });
    if (withLivekit) {
      await repo.setLivekitCredentials({
        nodeId: node.id,
        apiKey: livekitApiKey,
        apiSecretCiphertextBase64: encryptLivekitSecret(livekitSecret, encryptionKey, {
          nodeId: node.id,
          apiKey: livekitApiKey,
          wsUrl: livekitWsUrl,
        }),
        wsUrl: livekitWsUrl,
      });
    }
    console.log(
      `\n✓ fleet node registered${withLivekit ? ' + LiveKit creds set' : ' (identity only — no LiveKit creds)'}.`,
    );
    console.log(`  node uuid: ${node.id}`);
    console.log(`  display:   ${displayName} (${region}, ${hardwareClass})`);
    if (!withLivekit) {
      console.log(`  note:      set LiveKit creds later via POST /v1/mac-nodes/register.`);
    }
    console.log(`  → set DRIFTSTACK_MAC_NODE_ID=${node.id} on the harness daemon.\n`);
  } finally {
    await database.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
