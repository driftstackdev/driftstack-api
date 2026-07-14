// W799 — cross-SDK webhook-receiver-example parity. One-hundred-
// twenty-fifth in the drift-guard series. Pins the stdlib-only
// receive→verify→dispatch demo in lockstep across sdk-typescript /
// sdk-python / sdk-go. Drift here would let one SDK suggest an
// unsafe handler shape (e.g. parsing-before-verify) while another
// stays correct — the canonical signature-verification gospel must
// match across all 3.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/webhook-receiver.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/examples/webhook_receiver.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/examples/webhook_receiver/main.go');

describe('W799 cross-SDK webhook-receiver examples parity', () => {
  it('all 3 webhook-receiver example files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Stdlib-only / dep-free framing ───────────────────────────

  it("CRITICAL stdlib-only-no-framework-dep framing pinned cross-SDK. TS: 'Uses Node\\'s stdlib http server to keep the example dep-free' + Python: 'Stdlib-only — no Flask / FastAPI / Django dependency' + Go: 'stdlib-only webhook receiver ... No third-party HTTP framework dependency'. Drift would let one example pull a heavy framework dep and bias readers.", () => {
    expect(read(TS)).toMatch(/Uses Node's stdlib http server to keep the example dep-free/);
    expect(read(PY)).toMatch(/Stdlib-only — no Flask \/ FastAPI \/ Django dependency/);
    expect(read(GO)).toMatch(
      /stdlib-only webhook receiver: verify the[\s\S]*?No third-party HTTP framework/,
    );
  });

  // ─── Receive RAW BYTES (not parsed JSON) ──────────────────────

  it("CRITICAL receive-RAW-BYTES-not-parsed-JSON framing pinned in TS. The 'the principle is the same: receive RAW BYTES (not a parsed JSON body), pass them to verifyWebhookSignature, then parse + dispatch' wording is the load-bearing security teaching — parsing before verifying lets attackers smuggle malformed JSON that changes the verified bytes.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /receive RAW BYTES \(not a\s*\n\/\/ parsed JSON body\), pass them to verifyWebhookSignature, then parse \+\s*\n\/\/ dispatch\./,
    );
  });

  // ─── Verify-before-parse ordering ─────────────────────────────

  it('CRITICAL verify-before-parse ordering pinned cross-SDK. All 3 examples call verify_webhook_signature FIRST then JSON.parse / json.loads / json.Unmarshal SECOND. Drift to parsing first would break the security property.', () => {
    function verifyFirst(p: string, verifyMarker: RegExp, parseMarker: RegExp): boolean {
      const vIdx = p.search(verifyMarker);
      const pIdx = p.search(parseMarker);
      expect(vIdx, `verify marker not found: ${verifyMarker}`).toBeGreaterThan(-1);
      expect(pIdx, `parse marker not found: ${parseMarker}`).toBeGreaterThan(-1);
      return vIdx < pIdx;
    }

    expect(verifyFirst(read(TS), /verifyWebhookSignature\(\{/, /JSON\.parse\(body\.toString/)).toBe(
      true,
    );
    expect(
      verifyFirst(read(PY), /verify_webhook_signature\(body=body/, /json\.loads\(body\.decode/),
    ).toBe(true);
    expect(
      verifyFirst(read(GO), /VerifyWebhookSignature\(body, /, /json\.Unmarshal\(body, &evt\)/),
    ).toBe(true);
  });

  // ─── X-Driftstack-Signature header ────────────────────────────

  it("CRITICAL X-Driftstack-Signature header name pinned cross-SDK (case-insensitive). TS reads via lowercase 'x-driftstack-signature' (Node convention); Python reads lowercase too; Go uses canonical-case 'X-Driftstack-Signature'. Drift to a different header name would break every consumer.", () => {
    expect(read(TS)).toMatch(/req\.headers\['x-driftstack-signature'\]/);
    expect(read(PY)).toMatch(/self\.headers\.get\("x-driftstack-signature"\)/);
    expect(read(GO)).toMatch(/r\.Header\.Get\("X-Driftstack-Signature"\)/);
  });

  // ─── 401 on bad signature ─────────────────────────────────────

  it('CRITICAL 401-on-invalid-signature pinned cross-SDK. All 3 examples respond 401 when verification fails. Drift to a different status (403, 400) would diverge from the documented webhook contract.', () => {
    expect(read(TS)).toMatch(/res\.statusCode = 401;/);
    expect(read(PY)).toMatch(/self\.send_response\(401\)/);
    expect(read(GO)).toMatch(/http\.StatusUnauthorized/);
  });

  // ─── 204 on success + 30s timeout disclaimer ──────────────────

  it("CRITICAL 204-on-success + '2xx confirms receipt. Driftstack expects this within 30s' framing pinned in Python + Go. Drift to dropping the 30s SLA would lose the only quickstart-level documentation of the webhook-receipt timeout.", () => {
    expect(read(PY)).toMatch(/# 2xx confirms receipt\. Driftstack expects this within 30s\./);
    expect(read(PY)).toMatch(/self\.send_response\(204\)/);
    expect(read(GO)).toMatch(/\/\/ 2xx confirms receipt\. Driftstack expects this within 30s\./);
    expect(read(GO)).toMatch(/http\.StatusNoContent/);

    expect(read(TS)).toMatch(/res\.statusCode = 204;/);
  });

  // ─── Event dispatch — live quickstart subset ──────────────────

  it('CRITICAL event-type set pinned in TS — the quickstart handles three emitted core events and never advertises the removed silent quota subscriptions.', () => {
    const p = read(TS);
    expect(p).toMatch(/case 'session\.completed':/);
    expect(p).toMatch(/case 'session\.failed':/);
    expect(p).toMatch(/case 'api_key\.revoked':/);
    expect(p).not.toMatch(/quota\.warning_80pct/);
    expect(p).not.toMatch(/quota\.exceeded/);
  });

  it('CRITICAL Python HANDLERS dict matches the same emitted core subset and excludes silent quota subscriptions.', () => {
    const p = read(PY);
    expect(p).toMatch(/"session\.completed": handle_session_completed,/);
    expect(p).toMatch(/"session\.failed": handle_session_failed,/);
    expect(p).toMatch(/"api_key\.revoked": handle_api_key_revoked,/);
    expect(p).not.toMatch(/quota\.warning_80pct/);
    expect(p).not.toMatch(/quota\.exceeded/);
  });

  it('CRITICAL Go EventXxx constants pinned — EventSessionCompleted + EventAPIKeyRevoked. The typed-constant approach is Go-idiomatic; drift to string-literals would break go vet detection of typos.', () => {
    const p = read(GO);
    expect(p).toMatch(/case driftstack\.EventSessionCompleted:/);
    expect(p).toMatch(/case driftstack\.EventAPIKeyRevoked:/);
  });

  // ─── At-least-once / dedupe-by-event.id (TS) ──────────────────

  it("CRITICAL TS at-least-once + dedupe-by-event.id framing pinned. The 'Customers should treat events as at-least-once. Dedupe by event.id' comment is the load-bearing delivery-semantics teaching anchor.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /\/\/ Customers should treat events as at-least-once\. Dedupe by event\.id\./,
    );
  });

  // ─── Listening port — distinct cross-SDK ──────────────────────

  it("CRITICAL listening-port conventions pinned. TS uses PORT env-var (default 3000); Python + Go hardcode :4242 because the 'go run' / 'python examples/...' run-commands need a stable port for the 'point a webhook at http://localhost:4242/webhook' instruction to work.", () => {
    expect(read(TS)).toMatch(/const PORT = Number\(process\.env\.PORT \?\? '3000'\);/);
    expect(read(PY)).toMatch(/HTTPServer\(\("0\.0\.0\.0", 4242\), _Receiver\)/);
    expect(read(GO)).toMatch(/http\.ListenAndServe\(":4242", mux\)/);
    expect(read(PY)).toMatch(/http:\/\/localhost:4242\/webhook/);
    expect(read(GO)).toMatch(/http:\/\/localhost:4242\/webhook/);
  });

  // ─── DRIFTSTACK_WEBHOOK_SECRET env-var ────────────────────────

  it('CRITICAL DRIFTSTACK_WEBHOOK_SECRET env-var convention pinned cross-SDK. TS has dev-only fallback "whsec_dev_only"; Python + Go require it (sys.exit/log.Fatal).', () => {
    expect(read(TS)).toMatch(
      /const SECRET = process\.env\.DRIFTSTACK_WEBHOOK_SECRET \?\? 'whsec_dev_only';/,
    );
    expect(read(PY)).toMatch(/SECRET = os\.environ\.get\("DRIFTSTACK_WEBHOOK_SECRET", ""\)/);
    expect(read(PY)).toMatch(/if not SECRET:\s*\n\s+print\("DRIFTSTACK_WEBHOOK_SECRET required"/);
    expect(read(GO)).toMatch(/var secret = os\.Getenv\("DRIFTSTACK_WEBHOOK_SECRET"\)/);
    expect(read(GO)).toMatch(
      /if secret == "" \{\s*\n\s+log\.Fatal\("DRIFTSTACK_WEBHOOK_SECRET required"\)/,
    );
  });

  // ─── webhook URL path ─────────────────────────────────────────

  it("CRITICAL receiver-URL-path convention pinned. TS uses '/driftstack-webhook' (cross-app-routing-aware); Python + Go use '/webhook' (single-purpose process).", () => {
    expect(read(TS)).toMatch(/req\.url !== '\/driftstack-webhook'/);
    expect(read(PY)).toMatch(/self\.path != "\/webhook"/);
    expect(read(GO)).toMatch(/r\.URL\.Path != "\/webhook"/);
  });

  // ─── verify_webhook_signature import shape ────────────────────

  it('CRITICAL verifyWebhookSignature import shape pinned cross-SDK. TS: from "@driftstack/sdk" + Python: from driftstack + Go: driftstack.VerifyWebhookSignature method on package. Drift to a sub-module path would orphan docs.', () => {
    expect(read(TS)).toMatch(/import \{ verifyWebhookSignature \} from '@driftstack\/sdk';/);
    expect(read(PY)).toMatch(/from driftstack import verify_webhook_signature/);
    expect(read(GO)).toMatch(/driftstack\.VerifyWebhookSignature\(body, /);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-webhook-receiver-examples-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
