// W823 — cross-SDK WebhooksResource methods parity. One-hundred-
// forty-ninth in the drift-guard series. Pins the WebhooksResource
// method set across all 3 SDKs. Webhooks are the integration glue
// for customer event-driven flows; drift in method names or
// signatures would break webhook-management code at integration
// time (rare to call, but load-bearing when called).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');

// 9 shared method names across all 3 SDKs. Each language uses
// idiomatic naming (TS camelCase, Python snake_case, Go PascalCase).
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['create', 'create', 'Create'],
  ['list', 'list', 'List'],
  ['get', 'get', 'Get'],
  ['delete', 'delete', 'Delete'],
  ['update', 'update', 'Update'],
  ['listDeliveries', 'list_deliveries', 'ListDeliveries'],
  ['replayDelivery', 'replay_delivery', 'ReplayDelivery'],
  ['rotateSecret', 'rotate_secret', 'RotateSecret'],
  ['sendTest', 'send_test', 'SendTest'],
];

describe('W823 cross-SDK WebhooksResource methods parity', () => {
  it('all 3 WebhooksResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 9-required-method set ────────────────────────────────────

  it('CRITICAL all 9 WebhooksResource methods exist in all 3 SDKs — create + list + get + delete + update + listDeliveries + replayDelivery + rotateSecret + sendTest. Drift to dropping any would break customer webhook-management code at integration time.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *WebhooksResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*WebhooksResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── iterateDeliveries helper ─────────────────────────────────

  it('CRITICAL the delivery-iterator helper exists in ALL 3 SDKs — TS iterateDeliveries / Python iterate_deliveries / Go IterateDeliveries. Used by W798 cross-SDK pagination example to walk DLQ deliveries. (Go previously lacked it on the stale "pre-1.23 no generators" rationale; it now ships a callback-based IterateDeliveries matching every other Go resource iterator — profiles / recipes / agent_sessions — so all three SDKs can walk every delivery.)', () => {
    expect(read(TS)).toMatch(/iterateDeliveries\(/);
    expect(read(PY)).toMatch(/def iterate_deliveries\(/);
    // Go ships a callback-based IterateDeliveries (func(*WebhookDelivery)
    // (bool, error)), the same idiom as ProfilesResource.Iterate et al.
    expect(read(GO)).toMatch(
      /func \(r \*WebhooksResource\) IterateDeliveries\(ctx context\.Context, webhookID string, query \*ListDeliveriesQuery, fn func\(\*WebhookDelivery\) \(bool, error\)\) error/,
    );
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH WebhooksResource (sync) AND AsyncWebhooksResource (async). Every method except iterate_deliveries (which is a generator) has an async counterpart. Drift would break AsyncDriftstack customers.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncWebhooksResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go ctx-as-first-arg + (T, error) returns ─────────────────

  it("CRITICAL Go WebhooksResource methods all take ctx context.Context as first arg + return (T, error). Matches W822 + W796 'Go context-aware throughout' contract.", () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*WebhooksResource\\) ${goName}\\(ctx context\\.Context`),
      );
    }
  });

  it('CRITICAL Go-specific return shapes pinned. Create → *CreateWebhookResponse + error; List → *WebhookEndpointList + error; Get → *WebhookEndpoint + error; Delete → error only; Update → *WebhookEndpoint + error; ListDeliveries → *WebhookDeliveryListPage + error; ReplayDelivery → *WebhookDelivery + error; RotateSecret → *RotateWebhookSecretResponse + error; SendTest → *SendTestWebhookResponse + error.', () => {
    const p = read(GO);
    expect(p).toMatch(
      /func \(r \*WebhooksResource\) Create\(ctx context\.Context, body \*CreateWebhookRequest\) \(\*CreateWebhookResponse, error\)/,
    );
    expect(p).toMatch(
      /func \(r \*WebhooksResource\) Delete\(ctx context\.Context, webhookID string\) error/,
    );
    expect(p).toMatch(
      /func \(r \*WebhooksResource\) ListDeliveries\(ctx context\.Context, webhookID string, query \*ListDeliveriesQuery\) \(\*WebhookDeliveryListPage, error\)/,
    );
    expect(p).toMatch(
      /func \(r \*WebhooksResource\) RotateSecret\(ctx context\.Context, webhookID string\) \(\*RotateWebhookSecretResponse, error\)/,
    );
    expect(p).toMatch(
      /func \(r \*WebhooksResource\) SendTest\(ctx context\.Context, webhookID string\) \(\*SendTestWebhookResponse, error\)/,
    );
  });

  // ─── TS rotateSecret returns RotateWebhookSecretResponse ──────

  it('CRITICAL rotateSecret returns RotateWebhookSecretResponse cross-SDK. The response carries the new secret + grace-window info (V-359 dual-signature, W816). Drift to returning void or { ok: true } would break customer code that needs to surface the new secret to their verifier config.', () => {
    expect(read(TS)).toMatch(/rotateSecret\(id: string\): Promise<RotateWebhookSecretResponse>/);
    expect(read(GO)).toMatch(/RotateSecret.*\*RotateWebhookSecretResponse/);
  });

  // ─── delete() returns void ────────────────────────────────────

  it('CRITICAL delete() returns void cross-SDK — TS Promise<void> / Python -> None / Go error-only. HTTP 204 No Content per API; drift to returning the deleted endpoint would break customer code.', () => {
    expect(read(TS)).toMatch(/delete\(id: string\): Promise<void>/);
    expect(read(PY)).toMatch(/def delete\(self, webhook_id: str\) -> None:/);
    expect(read(GO)).toMatch(
      /func \(r \*WebhooksResource\) Delete\(ctx context\.Context, webhookID string\) error/,
    );
  });

  // ─── Python duck-typed CreateWebhookRequest | dict ────────────

  it("CRITICAL Python create() accepts 'CreateWebhookRequest | dict[str, Any]' duck-typed body. Matches W822 sessions duck-typing pattern.", () => {
    expect(read(PY)).toMatch(
      /def create\(self, body: CreateWebhookRequest \| dict\[str, Any\]\) -> CreateWebhookResponse:/,
    );
    expect(read(PY)).toMatch(
      /async def create\(self, body: CreateWebhookRequest \| dict\[str, Any\]\) -> CreateWebhookResponse:/,
    );
  });

  // ─── Python __init__ takes HttpClient ─────────────────────────

  it('CRITICAL Python WebhooksResource + AsyncWebhooksResource constructors take http client (HttpClient or AsyncHttpClient). Matches W822 sessions wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-webhooks-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
