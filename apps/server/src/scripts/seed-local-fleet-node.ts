/* eslint-disable no-console -- one-off operator CLI: the minted uuid must print */
// Local fleet-demo seed — register a Mac harness node + its LiveKit creds so the
// self-serve "create a profile → watch it live" flow can dispatch sessions to it.
//
// LOCAL DEV ONLY. Run against the local Postgres (NOT prod):
//
//   DATABASE_URL=postgres://... \
//   MFA_ENCRYPTION_KEY=<base64 32-byte key> \
//   FLEET_NODE_PUBLIC_KEY_BASE64URL=<harness Ed25519 pubkey, base64url> \
//   [LIVEKIT_API_KEY=devkey] [LIVEKIT_API_SECRET=secret] \
//   [LIVEKIT_WS_URL=ws://localhost:7880] \
//   npx tsx apps/server/src/scripts/seed-local-fleet-node.ts
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
  // server decrypts with at session-create — see maybeMintLivekit).
  const encryptionKey = required('MFA_ENCRYPTION_KEY');
  const publicKeyBase64Url = required('FLEET_NODE_PUBLIC_KEY_BASE64URL');
  const livekitApiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
  const livekitSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
  const livekitWsUrl = process.env.LIVEKIT_WS_URL ?? 'ws://localhost:7880';

  const database = createDb(databaseUrl, { max: 1 });
  try {
    const repo = new DrizzleFleetNodesRepo(database);
    const node = await repo.register({
      publicKeyBase64Url,
      displayName: 'local-mac-dev',
      region: 'local',
      hardwareClass: 'mac-dev',
    });
    await repo.setLivekitCredentials({
      nodeId: node.id,
      apiKey: livekitApiKey,
      apiSecretCiphertextBase64: encryptLivekitSecret(livekitSecret, encryptionKey),
      wsUrl: livekitWsUrl,
    });
    console.log(`\n✓ fleet node registered + LiveKit creds set.`);
    console.log(`  node uuid: ${node.id}`);
    console.log(`  → set DRIFTSTACK_MAC_NODE_ID=${node.id} on the harness daemon.\n`);
  } finally {
    await database.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
