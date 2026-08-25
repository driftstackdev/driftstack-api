// W686 — cross-SDK V-460/V-266 CLI 3-step activation handshake
// parity. Thirteenth in the cross-SDK drift-guard series (W649 verb
// + W675 error class + W676 problem-type URI + W677 auth/UA + W678
// webhook sig + W679 retry + W680 grace window + W681 plaintext-
// once + W682 step-up window + W683 Idempotency-Key + W684 URL
// escape + W685 RBAC-immune + W686 CLI activation).
//
// Asserts the V-460/V-266 CLI/GUI 3-step activation handshake is
// consistent across all 3 SDKs:
//
//   Step 1: initiate (POST /v1/auth/cli-authorize/initiate)
//     - PUBLIC route (CLI is unauthenticated at this point)
//     - Returns one-shot code + device-displayed user_code + browser_url
//     - CLI/GUI opens the URL; user signs in to dashboard
//
//   Step 2: bind (POST /v1/auth/cli-authorize/bind-device-code)
//     - WEB-SESSION-AUTHENTICATED (called by the dashboard's confirm
//       page after the user clicks Authorize)
//     - Mints a scoped API key on the calling account + stages it
//       for delivery via exchange
//
//   Step 3: exchange (POST /v1/auth/cli-authorize/exchange)
//     - POLLED by the CLI/GUI
//     - 3-branch discriminated-union response on `status`:
//       * pending — keep polling
//       * bound — ONE-SHOT delivery of plaintext api_key + account_id
//       * expired — user took too long, restart
//
// Drift on any of these 7 invariants would silently break the CLI
// activation flow — customers couldn't authorize their CLI/GUI tools
// against their Driftstack account.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_AUTH = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/auth.ts');
const GO_AUTH = resolve(REPO_ROOT, 'packages/sdk-go/auth.go');
const GO_TYPES = resolve(REPO_ROOT, 'packages/sdk-go/types.go');
const PY_AUTH = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/auth.py');
const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src/cli-authorize.ts');

describe('W686 cross-SDK V-460/V-266 CLI 3-step activation parity', () => {
  it('all 3 SDK auth resource files exist at canonical paths', () => {
    expect(existsSync(TS_AUTH), `missing ${TS_AUTH}`).toBe(true);
    expect(existsSync(GO_AUTH), `missing ${GO_AUTH}`).toBe(true);
    expect(existsSync(PY_AUTH), `missing ${PY_AUTH}`).toBe(true);
  });

  it('CRITICAL V-460 + V-266 anchors pinned in all 3 SDKs. V-460 is the CLI activation feature anchor; V-266 is the original GUI/dashboard auth-flow anchor. Drift to dropping either would lose changelog provenance for the cross-feature relationship.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    expect(ts).toMatch(/V-460/);
    expect(ts).toMatch(/V-266/);
    expect(go).toMatch(/V-460/);
    expect(go).toMatch(/V-266/);
    expect(py).toMatch(/V-460/);
    expect(py).toMatch(/V-266/);
  });

  it('CRITICAL 3 wire paths pinned in all 3 SDKs — initiate + bind + exchange. The 3-segment URL pattern (/v1/auth/cli-authorize/{initiate|bind|exchange}) is what the server-side routes match — drift to different paths would silently break every CLI activation flow.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/auth\/cli-authorize\/initiate/);
      expect(sdk).toMatch(/\/v1\/auth\/cli-authorize\/bind-device-code/);
      expect(sdk).toMatch(/\/v1\/auth\/cli-authorize\/exchange/);
    }
  });

  it('CRITICAL separate user_code is present in initiate and required on bind across typed SDK contracts', () => {
    const ts = read(TS_AUTH);
    const apiTypes = read(API_TYPES);
    const go = read(GO_AUTH);
    const goTypes = read(GO_TYPES);
    const py = read(PY_AUTH);

    expect(ts).toMatch(/separate user code displayed by the/);
    expect(apiTypes).toMatch(/user_code: CliAuthorizeUserCodeSchema/);
    expect(go).toMatch(/device-displayed user_code/);
    expect(goTypes).toMatch(/UserCode\s+string\s+`json:"user_code"`/);
    expect(py).toMatch(/device-displayed ``user_code``/);
  });

  it('CRITICAL Step 2 (bind) — web-session-authenticated invariant pinned in all 3 SDKs. CRITICAL: drift to allowing API-key auth on bind would defeat the human-in-the-loop dashboard-confirm step that prevents drive-by CLI authorization. Only a web session (= a user signed in to the dashboard) can mint a new API key for the CLI.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "Web-session-authenticated. Called by the dashboard's"
    expect(ts).toMatch(/Web-session-authenticated\. Called by the dashboard's/);

    // sdk-go: "Web-session-authenticated. Called"
    expect(go).toMatch(/Web-session-authenticated\. Called/);

    // sdk-python: "Web-session-authenticated. Called by the dashboard's confirm page"
    expect(py).toMatch(/Web-session-authenticated\. Called by the dashboard's confirm page/);
  });

  it('CRITICAL Step 3 (exchange) — 3-branch discriminated-union response pinned in all 3 SDKs. The 3 branches (pending / bound / expired) are the ONLY status values; drift to widening would break the exhaustive-switch pattern customers use to handle each case.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: 3-branch explicit listing with each status value pinned.
    expect(ts).toMatch(/\{ status: 'pending' \}/);
    expect(ts).toMatch(/\{ status: 'bound', api_key, account_id \}/);
    expect(ts).toMatch(/\{ status: 'expired' \}/);

    // sdk-go: similar 3-branch framing.
    expect(go).toMatch(/pending/);
    expect(go).toMatch(/bound/);
    expect(go).toMatch(/expired/);

    // sdk-python: similar.
    expect(py).toMatch(/``pending``/);
    expect(py).toMatch(/``bound``/);
    expect(py).toMatch(/``expired``/);
  });

  it('CRITICAL bound branch one-shot delivery framing pinned in all 3 SDKs. The bound branch carries the plaintext api_key + account_id payload — and is ONE-SHOT (subsequent calls return 404 OR change status). Drift to multi-shot would let stolen exchange requests re-fetch the plaintext key.', () => {
    const ts = read(TS_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "one-shot delivery\n   * of the plaintext API key. Subsequent calls 404."
    expect(ts).toMatch(/one-shot delivery\s*\*\s*of the plaintext API key\. Subsequent calls 404/);

    // sdk-python: "one-shot\n        delivery; ``api_key`` + ``account_id`` in body"
    expect(py).toMatch(/one-shot\s*delivery; ``api_key`` \+ ``account_id`` in body/);
  });

  it('CRITICAL polling + restart framing pinned in all 3 SDKs. The "Polled by the CLI/GUI" framing tells customers exchange is a POLL (NOT push); the "user took too long; restart the flow" wording tells customers expired means start over (NOT just retry the same exchange).', () => {
    const ts = read(TS_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "Polled by the CLI/GUI" + "user took too long; restart the flow"
    expect(ts).toMatch(/Polled by the CLI\/GUI/);
    expect(ts).toMatch(/user took too long; restart the flow/);

    // sdk-python: "Polled by the CLI/GUI"
    expect(py).toMatch(/Polled by the CLI\/GUI/);
  });

  it('CRITICAL "default scopes [\\"account_owner\\"]" framing pinned in sdk-typescript bind JSDoc. Drift to widening the default scopes would silently grant CLIs more privilege than the user intended (CLI customers expect minimum-privilege keys by default).', () => {
    const ts = read(TS_AUTH);
    expect(ts).toMatch(/Default scopes are\s*\*\s*`\["account_owner"\]` server-side/);
  });

  it("Cross-flow consistency — all 3 SDKs implement the 3-step handshake in the same ORDER (initiate → bind → exchange). The order is load-bearing because exchange depends on bind's mint-and-stage step. Drift to a different order would break the handshake.", () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    for (const sdk of [ts, go, py]) {
      const initiatePos = sdk.search(/cli-authorize\/initiate/);
      const bindPos = sdk.search(/cli-authorize\/bind-device-code/);
      const exchangePos = sdk.search(/cli-authorize\/exchange/);

      expect(initiatePos, 'initiate position').toBeGreaterThan(0);
      expect(bindPos, 'bind position').toBeGreaterThan(initiatePos);
      expect(exchangePos, 'exchange position').toBeGreaterThan(bindPos);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-cli-activation-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
