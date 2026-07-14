// Drift guard for apps/server/src/db/fleet-nodes-repo.ts. Pins V-820
// Drizzle implementation of FleetNodesRepo (migration 0043) — the
// shipped FleetNodesRepo interface is just `getPublicKey(nodeId)`;
// this impl adds register/revoke/touchLastSeen/getDetail/listActive
// for the operator routes. LK.1 per-Mac LiveKit credentials all-or-
// none CHECK invariant. The intentional asymmetry is documented.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/fleet-nodes-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/fleet-nodes-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-820 module-level framing pinned: 'Drizzle implementation of FleetNodesRepo (migration 0043). Production wires this; the InMemoryFleetNodesRepo in services/fleet-node-auth.ts continues to back tests + dev mode.' — pinned so the V-820 anchor + migration 0043 + production-vs-InMemory split contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-820 — Drizzle implementation of FleetNodesRepo \(migration 0043\)\./,
    );
    expect(body).toMatch(
      /\/\/ Production wires this; the InMemoryFleetNodesRepo in\s*\n?\s*\/\/ services\/fleet-node-auth\.ts continues to back tests \+ dev mode\./,
    );
  });

  it("Interface-vs-class asymmetry framing pinned: 'The shipped FleetNodesRepo interface is getPublicKey(nodeId). This impl adds register / revoke / touchLastSeen / getDetail / listActive methods on the class (not the interface) because the future operator routes (POST /v1/admin/fleet-nodes, /revoke, GET list, GET detail) consume the concrete class. Adding them to the interface would require the InMemory variant to grow too; the operator routes only run against the Drizzle path so this asymmetry is intentional.' — pinned so the interface-getPublicKey-only + class-has-5-extra + operator-routes-Drizzle-only contract all stay documented (drift to adding extra methods to the interface would force InMemory parity that has no test value)", () => {
    expect(body).toMatch(
      /\/\/ The shipped `FleetNodesRepo` interface is `getPublicKey\(nodeId\)`\.\s*\n?\s*\/\/ This impl adds `register` \/ `revoke` \/ `touchLastSeen` \/\s*\n?\s*\/\/ `getDetail` \/ `listActive` methods on the class \(not the interface\)\s*\n?\s*\/\/ because the future operator routes\s*\n?\s*\/\/ \(POST \/v1\/admin\/fleet-nodes, \/revoke, GET list, GET detail\) consume\s*\n?\s*\/\/ the concrete class\./,
    );
    expect(body).toMatch(
      /Adding them to the interface would require the\s*\n?\s*\/\/ InMemory variant to grow too; the operator routes only run against\s*\n?\s*\/\/ the Drizzle path so this asymmetry is intentional\./,
    );
  });

  it("FleetNodeDetail 11-field interface shape pinned: id + publicKeyBase64Url + displayName + region + hardwareClass + registeredAt + lastSeenAt (nullable) + lastHeartbeat (FleetNodeHeartbeatSnapshot|null, migration 0083) + revokedAt (nullable) + revocationReason (nullable) + livekit (nullable union). + LK.1 'per-Mac LiveKit credentials. All four fields are set together (CHECK constraint) or all four are NULL (pre-LK.2).' — pinned so the shape + LK.1 all-or-none CHECK constraint contract stay documented (drift to allowing partial LK fields would diverge from the DB CHECK constraint)", () => {
    // toContain fragments (not a closed multi-line regex) so field additions +
    // prettier reflow don't brittle-break the pin.
    expect(body).toContain('export interface FleetNodeDetail {');
    expect(body).toContain('nodeId: string | null;');
    expect(body).toContain('publicKeyBase64Url: string;');
    expect(body).toContain('lastSeenAt: Date | null;');
    expect(body).toContain('lastHeartbeat: FleetNodeHeartbeatSnapshot | null;');
    expect(body).toContain('revokedAt: Date | null;');
    expect(body).toContain('revocationReason: string | null;');
    expect(body).toMatch(
      /\/\*\* LK\.1 — per-Mac LiveKit credentials\. All four fields are set\s*\n?\s*\*\s+together \(CHECK constraint\) or all four are NULL \(pre-LK\.2\)\. \*\//,
    );
    expect(body).toMatch(
      /livekit: \{\s*\n?\s*apiKey: string;\s*\n?\s*apiSecretCiphertextBase64: string;\s*\n?\s*wsUrl: string;\s*\n?\s*registeredAt: Date;\s*\n?\s*\} \| null;/,
    );
  });

  it('RegisterFleetNodeArgs interface pinned: publicKeyBase64Url + displayName + region + hardwareClass + optional nodeId (migration 0085 human identity) + optional registeredAt (test-injectable). toContain fragments (not a closed regex) so field additions + prettier reflow do not brittle-break the pin.', () => {
    expect(body).toContain('export interface RegisterFleetNodeArgs {');
    expect(body).toContain('publicKeyBase64Url: string;');
    expect(body).toContain('displayName: string;');
    expect(body).toContain('hardwareClass: string;');
    expect(body).toContain('nodeId?: string;');
    expect(body).toContain('registeredAt?: Date;');
  });

  it('LK.2 SetFleetNodeLivekitArgs pins the explicit versioned record-bound envelope', () => {
    expect(body).toMatch(
      /\/\*\* LK\.2 — credentials the Mac harness POSTs to the control plane on\s*\n?\s*\*\s+boot\. apiSecretCiphertextBase64 is the explicit versioned,\s*\n?\s*\*\s+record-bound envelope produced by encryptLivekitSecret\(\)\. \*\//,
    );
    expect(body).toMatch(
      /export interface SetFleetNodeLivekitArgs \{\s*\n?\s*nodeId: string;\s*\n?\s*apiKey: string;\s*\n?\s*apiSecretCiphertextBase64: string;\s*\n?\s*wsUrl: string;\s*\n?\s*registeredAt\?: Date;\s*\n?\s*\}/,
    );
  });

  it('DrizzleFleetNodesRepo class declared as implements FleetNodesRepo (interface) + constructor takes Database. Drift to adding the asymmetry-mentioned methods (register/revoke/etc) to the interface would force InMemory parity (rejected per intentional asymmetry)', () => {
    expect(body).toMatch(
      /export class DrizzleFleetNodesRepo implements FleetNodesRepo \{\s*\n?\s*constructor\(private readonly database: Database\) \{\}/,
    );
  });

  it('boot migration prevalidates pages, probes v2, exact-CASes the five old tuple fields, and preserves registration time', () => {
    expect(body).toContain('async migrateLivekitSecretEnvelopes(');
    expect(body).toContain('decryptLivekitSecret(v2Probe.ciphertext, keyBase64');
    expect(body).toContain('decryptLegacyLivekitSecret(row.ciphertext, keyBase64)');
    expect(body).toContain('const prepared = rows.map((row) => {');
    expect(body).toContain('eq(fleetNodes.id, row.id)');
    expect(body).toContain('eq(fleetNodes.livekitApiKey, row.apiKey)');
    expect(body).toContain('eq(fleetNodes.livekitApiSecretCiphertext, row.ciphertext)');
    expect(body).toContain('eq(fleetNodes.livekitWsUrl, row.wsUrl)');
    expect(body).toContain('eq(fleetNodes.livekitRegisteredAt, row.registeredAt)');
    expect(body).not.toContain('livekitRegisteredAt: row.next');
  });
});
