// Regenerates the driftstack-api MIRROR of the shared OVPN file-reference
// contract from the CANONICAL copy in the sibling driftstack repo.
//
//   npm run sync:ovpn-fixtures
//
// Why a mirror at all: the api-types suite must read this contract in CI, where
// driftstack-api is checked out ALONE (no sibling driftstack), so a cross-repo
// path would resolve to nothing and the pin would silently read an empty file —
// the false-green this whole contract exists to prevent. The suite therefore
// reads the in-repo mirror; the drift guard in
// openvpn-file-reference-contract.test.ts reds at the pre-push gate (where both
// repos are present) if the mirror and canonical ever diverge. This script makes
// re-syncing one command, so closing that red is "run this", not "remember how to
// copy a file byte-for-byte".
//
// Cross-source pin with the node parse-reject (A3 8a03a3929); canonical lives at
// driftstack/operations/contracts/openvpn-file-reference-fixtures.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CANON = resolve(
  here,
  '../../driftstack/operations/contracts/openvpn-file-reference-fixtures.json',
);
const MIRROR = resolve(
  here,
  '../packages/api-types/tests/fixtures/openvpn-file-reference-fixtures.json',
);

if (!existsSync(CANON)) {
  console.error(
    `[sync:ovpn-fixtures] canonical not found at ${CANON}\n` +
      `  The sibling driftstack repo must be checked out next to driftstack-api to regenerate.`,
  );
  process.exit(1);
}

const bytes = readFileSync(CANON);
mkdirSync(dirname(MIRROR), { recursive: true });
writeFileSync(MIRROR, bytes);
console.log(`[sync:ovpn-fixtures] wrote ${bytes.length} bytes\n  ${CANON}\n  -> ${MIRROR}`);
