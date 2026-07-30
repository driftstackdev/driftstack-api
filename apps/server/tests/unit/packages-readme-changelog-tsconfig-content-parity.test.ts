// W618 — drift guard for 12 package-level meta files:
//  - 4 READMEs: api-types + sdk-go + sdk-python + sdk-typescript
//  - 3 SDK CHANGELOGs: sdk-go + sdk-python + sdk-typescript
//  - 5 tsconfig.json: behavioural-simulation + recapture-automation +
//    recipe-library + webhook-delivery + webrtc-streaming

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P = (rel: string) => resolve(REPO_ROOT, `packages/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W618 packages READMEs + CHANGELOGs + tsconfigs content parity', () => {
  it('api-types/README.md: @driftstack/api-types pre-1.0 Zod-schemas + TS-types single-source-of-truth + exact pin guidance + 7-section export list + SemVer pre-1.0 rules + MIT pinned', () => {
    const body = read(P('api-types/README.md'));
    expect(body).toMatch(/^# @driftstack\/api-types$/m);
    expect(body).toMatch(/Zod schemas \+ TypeScript types for the public \[Driftstack\]/);
    expect(body).toMatch(/The single source of truth for the API contract/);
    expect(body).toMatch(/the OpenAPI 3\.1 spec is generated from these schemas/);
    expect(body).toMatch(/\*\*Status:\*\* pre-1\.0\. Pin an exact package version in production/);
    expect(body).toMatch(/^## Install$/m);
    expect(body).toMatch(/^npm install @driftstack\/api-types$/m);
    expect(body).toMatch(/transitive dependency of `@driftstack\/sdk`/);
    expect(body).toMatch(/^## Usage$/m);
    expect(body).toMatch(
      /import \{ CreateSessionRequestSchema, type Session, type Problem \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/^## What's exported$/m);
    expect(body).toMatch(
      /\*\*Resource schemas \+ types:\*\* `Account`, `ApiKey`, `Session`, `SessionState`/,
    );
    expect(body).toMatch(
      /\*\*Request \/ response schemas:\*\* `CreateSessionRequest`, `NavigateRequest`/,
    );
    expect(body).toMatch(/\*\*Auth flow\*\* \(V-079\): `SignupRequest` \/ `SignupResponse`/);
    expect(body).toMatch(/\*\*Billing\*\* \(V-082\): `CreateCheckoutSessionRequest`/);
    expect(body).toMatch(/\*\*Discriminated unions:\*\* `InteractAction`, `WaitCondition`\./);
    expect(body).toMatch(/\*\*Common shapes:\*\* `Problem` \(RFC 7807 error envelope\)/);
    expect(body).toMatch(
      /\*\*Closed enums:\*\* `AccountTier`, `AccountStatus`, `ApiKeyScope`, `SessionStatus`, `WebhookEventType`, `WebhookDeliveryStatus`, `SubscriptionStatus`\./,
    );
    expect(body).toMatch(/\*\*Stable problem-type URIs:\*\* `PROBLEM_TYPES`/);
    expect(body).toMatch(/^## Versioning$/m);
    expect(body).toMatch(/`0\.x\.y` follows SemVer's pre-1\.0 rules/);
    expect(body).toMatch(/^## License$/m);
    expect(body).toMatch(/^MIT\.$/m);
    expect(existsSync(P('api-types/README.md'))).toBe(true);
  });

  it('sdk-typescript/README.md: @driftstack/sdk pre-1.0 + Node 18+ native-fetch + Driftstack ctor (apiKey + baseUrl + timeoutMs + retry maxAttempts/initialDelayMs/maxDelayMs) + resource list (sessions + profiles + profileSnapshots V-312 + apiKeys + V-296 rotate) pinned', () => {
    const body = read(P('sdk-typescript/README.md'));
    expect(body).toMatch(/^# @driftstack\/sdk$/m);
    expect(body).toMatch(/Official TypeScript SDK for the \[Driftstack\]/);
    expect(body).toMatch(/\*\*Status:\*\* pre-1\.0\./);
    expect(body).toMatch(/^npm install @driftstack\/sdk$/m);
    expect(body).toMatch(/Requires Node\.js ≥ 18 \(uses native `fetch`\)/);
    expect(body).toMatch(/^## Quickstart$/m);
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(body).toMatch(
      /const client = new Driftstack\(\{ apiKey: process\.env\.DRIFTSTACK_API_KEY! \}\);/,
    );
    expect(body).toMatch(/^## Configuration$/m);
    expect(body).toMatch(/apiKey: 'ds_live_…', \/\/ required/);
    expect(body).toMatch(/baseUrl: 'https:\/\/api\.driftstack\.dev', \/\/ optional override/);
    expect(body).toMatch(/timeoutMs: 30_000, \/\/ per-request timeout/);
    expect(body).toMatch(/maxAttempts: 3,/);
    expect(body).toMatch(/initialDelayMs: 200,/);
    expect(body).toMatch(/maxDelayMs: 10_000,/);
    expect(body).toMatch(/^## Resources$/m);
    expect(body).toMatch(/client\.sessions\.create\(body\?\)/);
    expect(body).toMatch(/client\.sessions\.navigate\(id, body\)/);
    expect(body).toMatch(/client\.sessions\.capture\(id, body\)/);
    expect(body).toMatch(
      /client\.profileSnapshots\.capture\(profileId, body\)\s+\/\/ V-312 — immutable point-in-time copy/,
    );
    expect(body).toMatch(
      /client\.apiKeys\.rotate\(id, options\?\)\s+\/\/ V-296 — 24h grace, plaintext shown once/,
    );
    expect(body).toMatch(/client\.team\.listOwners\(\)/);
    // The two direct browser operations are typed but capability-gated. Listing
    // them beside the always-available verbs without that note would market
    // availability no shipped deployment has (every driver reports non-real
    // capability, so both routes return 503 before session lookup).
    expect(body).toMatch(
      /client\.sessions\.search\(id, body\) \/\/ capability-gated — 503 unless the deployment has a real direct driver/,
    );
    expect(body).toMatch(
      /client\.sessions\.login\(id, body\)\s+\/\/ capability-gated — 503 unless the deployment has a real direct driver/,
    );
    expect(existsSync(P('sdk-typescript/README.md'))).toBe(true);
  });

  it('sdk-go/README.md: tagged pre-1.0 registry install + go.sum reproducibility + runtime/lifecycle/resources pinned', () => {
    const body = read(P('sdk-go/README.md'));
    expect(body).toMatch(/^# Driftstack Go SDK$/m);
    expect(body).toMatch(
      /Stealth iPhone Safari automation, called from Go\. Single-package, zero non-stdlib runtime dependencies, context-aware throughout\./,
    );
    expect(body).toMatch(
      /\*\*Status:\*\* published as a tagged pre-1\.0 module\. Commit `go\.mod` and `go\.sum` for reproducible deployments\./,
    );
    expect(body).toMatch(
      /^go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go@latest$/m,
    );
    expect(body).not.toMatch(/@<commit>|pseudo-version|first tag pending/i);
    expect(body).toMatch(/Requires Go 1\.22\+/);
    expect(body).toMatch(/^## Quickstart$/m);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
    expect(body).toMatch(/client := driftstack\.New\("ds_live_…"\)/);
    expect(body).toMatch(/defer client\.Close\(\)/);
    expect(body).toMatch(/ctx := context\.Background\(\)/);
    expect(body).toMatch(/s, err := client\.Sessions\.Create\(ctx, nil\)/);
    expect(body).toMatch(/^## Resources$/m);
    expect(body).toMatch(
      /Every public API endpoint is a typed method on a resource accessor\. All take `context\.Context` first\./,
    );
    expect(body).toMatch(
      /`client\.Sessions`\s+\| `Create`, `List`, `Get`, `Navigate`, `Interact`, `Wait`, `GetState`, `Capture`, `Extract`, `Search`, `Login`, `Destroy`/,
    );
    expect(body).toMatch(
      /`client\.Profiles`\s+\| `Create`, `List`, `Iterate`, `Get`, `Update`, `Delete`, `Clone` \(V-313\)/,
    );
    expect(body).toMatch(
      /`client\.ProfileSnapshots` \| `Capture`, `ListForProfile`, `List`, `Iterate`, `Get`, `Restore`, `Delete` \(V-312\)/,
    );
    expect(body).toMatch(/`client\.APIKeys`\s+\| `Create`, `List`, `Rotate` \(V-296\), `Revoke`/);
    expect(body).toMatch(/`client\.Team`\s+\|[^\n]*`ListOwners`/);
    expect(existsSync(P('sdk-go/README.md'))).toBe(true);
  });

  it('sdk-python/README.md: PyPI pre-1.0 install + lockfile reproducibility + dist/import + sync/async resources pinned', () => {
    const body = read(P('sdk-python/README.md'));
    expect(body).toMatch(/^# Driftstack Python SDK$/m);
    expect(body).toMatch(
      /Stealth iPhone Safari automation, called from Python\. Sync \(`Driftstack`\) and async \(`AsyncDriftstack`\) clients in one package/,
    );
    expect(body).toMatch(
      /\*\*Status:\*\* published on PyPI, pre-1\.0, and classified Alpha\. Use requirements constraints or a lockfile for reproducible deployments\./,
    );
    expect(body).toMatch(/^pip install driftstack-sdk$/m);
    expect(body).not.toMatch(/@<commit>#subdirectory=packages\/sdk-python|PyPI tag pending/i);
    expect(body).toMatch(
      /The distribution name is `driftstack-sdk`; the import name is `driftstack`\./,
    );
    expect(body).toMatch(/Requires Python 3\.10\+\./);
    expect(body).toMatch(/^## Quickstart \(sync\)$/m);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/with Driftstack\(api_key="ds_live_…"\) as client:/);
    expect(body).toMatch(/^## Quickstart \(async\)$/m);
    expect(body).toMatch(/from driftstack import AsyncDriftstack/);
    expect(body).toMatch(/async with AsyncDriftstack\(api_key="ds_live_…"\) as client:/);
    expect(body).toMatch(/^## Resources$/m);
    expect(body).toMatch(
      /`client\.sessions`\s+\| `create`, `list`, `get`, `navigate`, `interact`, `wait`, `get_state`, `capture`, `extract`, `search`, `login`, `destroy`/,
    );
    expect(body).toMatch(
      /`client\.profile_snapshots` \| `capture`, `list_for_profile`, `list`, `iterate`, `get`, `restore`, `delete` \(V-312 — immutable point-in-time copies\)/,
    );
    expect(body).toMatch(/`client\.api_keys`\s+\| `create`, `list`, `rotate` \(V-296\), `revoke`/);
    expect(body).toMatch(
      /`client\.team`\s+\| `invite`, `list_members`, `list_invites`, `list_owners`, `accept_invite`, `remove_member` \(V-298\)/,
    );
    expect(body).toMatch(/`client\.account`\s+\| `me` \(V-385/);
    expect(existsSync(P('sdk-python/README.md'))).toBe(true);
  });

  it('sdk-go/CHANGELOG.md: Keep-a-Changelog 1.1.0 + SemVer 2.0.0 + Unreleased section + V-666 crypto_orders Go-parity Quote/CreateCheckout (V-666.AO Idempotency-Key) + V-463/V-356 SendTest + V-464/V-351 Update + V-462/V-297 AuditLog.Export + V-460/V-266 CliAuthorize 3-method activation flow pinned', () => {
    const body = read(P('sdk-go/CHANGELOG.md'));
    expect(body).toMatch(/^# Changelog$/m);
    expect(body).toMatch(/All notable changes to the Driftstack Go SDK\./);
    expect(body).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
    expect(body).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    expect(body).toMatch(/^## \[Unreleased\]$/m);
    expect(body).toMatch(/^### Added$/m);
    expect(body).toMatch(/client\.Team\.ListOwners\(ctx\)/);
    expect(body).toMatch(/\*\*`client\.CryptoOrders\.\*`\*\* \(V-666 Go parity\)/);
    expect(body).toMatch(/`Quote`, `CreateCheckout`/);
    expect(body).toMatch(/V-666\.AO header/);
    expect(body).toMatch(
      /Crypto payments\s*\n?\s*are non-refundable; cancellation only works while pending\./,
    );
    expect(body).toMatch(
      /\*\*`client\.Webhooks\.SendTest\(ctx, webhookID\)`\*\* \(V-463 \/ V-356\)/,
    );
    expect(body).toMatch(
      /\*\*`client\.Webhooks\.Update\(ctx, webhookID, \*UpdateWebhookRequest\)`\*\*/,
    );
    expect(body).toMatch(/\(V-464 \/ V-351\)/);
    expect(body).toMatch(/\*\*`client\.AuditLog\.Export\(ctx\)`\*\* \(V-462 \/ V-297\)/);
    expect(body).toMatch(/Designed for GDPR\s*\n?\s+Article 20 data-portability requests/);
    expect(body).toMatch(/up to 10,000 rows per call/);
    expect(body).toMatch(/\*\*CLI\/GUI activation flow\*\* \(V-460 \/ V-266\)/);
    expect(body).toMatch(/three new methods on/);
    expect(body).toMatch(/`client\.Auth`: `CliAuthorizeInitiate`, `CliAuthorizeBind`, and/);
    expect(body).toMatch(/`CliAuthorizeExchange`/);
    expect(existsSync(P('sdk-go/CHANGELOG.md'))).toBe(true);
  });

  it('sdk-typescript/CHANGELOG.md: Keep-a-Changelog 1.1.0 + SemVer 2.0.0 + Unreleased + V-463/V-356 webhooks.sendTest test.ping + V-464/V-351 webhooks.update + V-462/V-297 auditLog.export GDPR-Art-20 + V-460/V-266 cliAuthorize 3-method flow + V-312 profileSnapshots pinned', () => {
    const body = read(P('sdk-typescript/CHANGELOG.md'));
    expect(body).toMatch(/^# Changelog$/m);
    expect(body).toMatch(/All notable changes to the Driftstack TypeScript SDK\./);
    expect(body).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
    expect(body).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    expect(body).toMatch(/^## \[Unreleased\]$/m);
    expect(body).toMatch(/client\.team\.listOwners\(\)/);
    expect(body).toMatch(/\*\*`client\.webhooks\.sendTest\(id\)`\*\* \(V-463 \/ V-356\)/);
    expect(body).toMatch(/synthetic `test\.ping` delivery/);
    expect(body).toMatch(/\*\*`client\.webhooks\.update\(id, body\)`\*\* \(V-464 \/ V-351\)/);
    expect(body).toMatch(/\*\*`client\.auditLog\.export\(\)`\*\* \(V-462 \/ V-297\)/);
    expect(body).toMatch(/GDPR\s*\n?\s*Article 20 data-portability requests/);
    expect(body).toMatch(/[Uu]p to 10,000 rows per call/);
    expect(body).toMatch(/\*\*CLI\/GUI activation flow\*\* \(V-460 \/ V-266\)/);
    expect(body).toMatch(/`client\.auth`: `cliAuthorizeInitiate`, `cliAuthorizeBind`/);
    expect(body).toMatch(/`cliAuthorizeExchange`/);
    expect(body).toMatch(/\*\*`client\.profileSnapshots`\*\* — V-312 immutable point-in-time/);
    expect(existsSync(P('sdk-typescript/CHANGELOG.md'))).toBe(true);
  });

  it('sdk-python/CHANGELOG.md: Keep-a-Changelog 1.1.0 + SemVer 2.0.0 + Unreleased + V-666 crypto_orders Python parity (quote + create_checkout idempotency_key kwarg + list/iterate + get/cancel/receipt + update_note) + V-463/V-356 send_test async-mirror + V-464/V-351 update + V-462/V-297 audit_log.export + V-460/V-266 cli_authorize_* 3-method flow pinned', () => {
    const body = read(P('sdk-python/CHANGELOG.md'));
    expect(body).toMatch(/^# Changelog$/m);
    expect(body).toMatch(/All notable changes to the `driftstack` Python SDK\./);
    expect(body).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
    expect(body).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    expect(body).toMatch(/^## \[Unreleased\]$/m);
    expect(body).toMatch(/client\.team\.list_owners\(\)/);
    expect(body).toMatch(
      /\*\*`client\.crypto_orders\.\*`\*\* \+ async mirror \(V-666 Python parity\)/,
    );
    expect(body).toMatch(/`quote\(body\)`,/);
    expect(body).toMatch(/`create_checkout\(body, \*, idempotency_key=None\)`/);
    expect(body).toMatch(
      /`get\(order_id\)`, `update_note\(order_id, body\)`, `cancel\(order_id\)`/,
    );
    expect(body).toMatch(/Crypto payments are\s*\n?\s*non-refundable/);
    expect(body).toMatch(/\*\*`client\.webhooks\.send_test\(webhook_id\)`\*\* \+ async mirror/);
    expect(body).toMatch(/\(V-463 \/ V-356\)/);
    expect(body).toMatch(/\*\*`client\.webhooks\.update\(webhook_id, body\)`\*\* \+ async mirror/);
    expect(body).toMatch(/\(V-464 \/ V-351\)/);
    expect(body).toMatch(
      /\*\*`client\.audit_log\.export\(\)`\*\* \+ async mirror \(V-462 \/ V-297\)/,
    );
    expect(body).toMatch(/up to 10,000\s*\n?\s+rows per call/);
    expect(body).toMatch(/\*\*CLI\/GUI activation flow\*\* \(V-460 \/ V-266\)/);
    expect(body).toMatch(/`client\.auth` plus async mirrors: `cli_authorize_initiate`/);
    expect(body).toMatch(/`cli_authorize_bind`, and `cli_authorize_exchange`/);
    expect(existsSync(P('sdk-python/CHANGELOG.md'))).toBe(true);
  });

  it('5 packages tsconfig.json (behavioural-simulation + recapture-automation + recipe-library + webhook-delivery + webrtc-streaming) shared shape: extends ../../tsconfig.base.json + rootDir src + outDir dist + composite true + tsBuildInfoFile dist/.tsbuildinfo + include src/**/* + exclude dist/node_modules/tests pinned', () => {
    const expectedShape = (pkg: string) => {
      const body = read(P(`${pkg}/tsconfig.json`));
      expect(body).toMatch(/"extends": "\.\.\/\.\.\/tsconfig\.base\.json"/);
      expect(body).toMatch(/"rootDir": "src"/);
      expect(body).toMatch(/"outDir": "dist"/);
      expect(body).toMatch(/"composite": true/);
      expect(body).toMatch(/"tsBuildInfoFile": "dist\/\.tsbuildinfo"/);
      expect(body).toMatch(/"include": \["src\/\*\*\/\*"\]/);
      expect(body).toMatch(/"exclude": \["dist", "node_modules", "tests"\]/);
      expect(existsSync(P(`${pkg}/tsconfig.json`))).toBe(true);
    };
    expectedShape('behavioural-simulation');
    expectedShape('recapture-automation');
    expectedShape('recipe-library');
    expectedShape('webhook-delivery');
    expectedShape('webrtc-streaming');
  });
});
