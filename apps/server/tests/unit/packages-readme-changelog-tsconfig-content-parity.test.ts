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
  it('api-types/README.md: @driftstack/api-types pre-1.0 Zod-schemas + TS-types single-source-of-truth + 0.x minor-vs-patch guidance + 7-section export list + SemVer pre-1.0 rules + MIT pinned. The pin MOVED on 2026-09-20: this asserted "Pin an exact package version in production", which was one of four published documents giving four different answers — the SDK README said the opposite in the same breath. The guidance is now one answer in every ecosystem\'s terms, and the-published-packages-give-one-answer-about-version-pinning holds all six documents to it', () => {
    const body = read(P('api-types/README.md'));
    expect(body).toMatch(/^# @driftstack\/api-types$/m);
    expect(body).toMatch(/Zod schemas \+ TypeScript types for the public \[Driftstack\]/);
    expect(body).toMatch(/The single source of truth for the API contract/);
    expect(body).toMatch(/the OpenAPI 3\.1 spec is generated from these schemas/);
    expect(body).toMatch(
      /\*\*Status:\*\* pre-1\.0\. While the package is `0\.x`, a minor version can change the surface and a patch never does/,
    );
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
    expect(body).toMatch(/\*\*Auth flow[^\n]*SignupRequest` \/ `SignupResponse`/);
    expect(body).toMatch(/\*\*Billing[^\n]*CreateCheckoutSessionRequest`/);
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

  it('sdk-typescript/README.md: @driftstack/sdk pre-1.0 + Node 18+ native-fetch + Driftstack ctor (apiKey + baseUrl + timeoutMs + retry maxAttempts/initialDelayMs/maxDelayMs) + resource list (sessions + profiles + profileSnapshots capture + apiKeys rotate) pinned', () => {
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
      /client\.profileSnapshots\.capture\(profileId, body\)\s+\/\/[^\n]*immutable point-in-time copy/,
    );
    expect(body).toMatch(
      /client\.apiKeys\.rotate\(id, options\?\)\s+\/\/[^\n]*24h grace, plaintext shown once/,
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
      /`client\.Profiles`\s+\| `Create`, `List`, `Iterate`, `Get`, `Update`, `Delete`, `Clone`/,
    );
    expect(body).toMatch(
      /`client\.ProfileSnapshots` \| `Capture`, `ListForProfile`, `List`, `Iterate`, `Get`, `Restore`, `Delete`/,
    );
    expect(body).toMatch(/`client\.APIKeys`\s+\| `Create`, `List`, `Rotate[^\n]*Revoke`/);
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
      /`client\.profile_snapshots` \| `capture`, `list_for_profile`, `list`, `iterate`, `get`, `restore`, `delete[^\n]*immutable point-in-time copies\)/,
    );
    expect(body).toMatch(/`client\.api_keys`\s+\| `create`, `list`, `rotate[^\n]*revoke`/);
    expect(body).toMatch(
      /`client\.team`\s+\| `invite`, `list_members`, `list_invites`, `list_owners`, `accept_invite`, `remove_member`/,
    );
    expect(body).toMatch(
      /`client\.account`\s+\| `me`[^|]*full \/v1\/account\/me with slug \/ region \/ avatar \/ mfa \/ teams/,
    );
    expect(existsSync(P('sdk-python/README.md'))).toBe(true);
  });

  // ── The three SDK CHANGELOGs ────────────────────────────────
  //
  // 2026-09-20 — these three pins used to quote the `[Unreleased]` prose word
  // for word, internal ticket ids included: a guard on a CUSTOMER-FACING file
  // that REQUIRED `(V-463 / V-356)` to appear in it. The 0.2.0 / 0.3.0 release
  // rewrote those sections for a customer and dated them, so the pins are now
  // on what each entry CLAIMS — the release heading, the fresh [Unreleased],
  // and the capabilities a customer would notice losing — and never on an
  // identifier that only means something inside this repo.

  it('sdk-go/CHANGELOG.md: Keep-a-Changelog 1.1.0 + SemVer 2.0.0 + a fresh [Unreleased] above the dated 0.3.0 entry + the never-tagged 0.2.0 kept as history + migration from the last published tag + team owners + crypto orders (forward-compatible envelopes, non-refundable) + webhook send-test/update + audit-log export (10,000 rows) + the CLI activation flow', () => {
    const body = read(P('sdk-go/CHANGELOG.md'));
    expect(body).toMatch(/^# Changelog$/m);
    expect(body).toMatch(/All notable changes to the Driftstack Go SDK\./);
    expect(body).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
    expect(body).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    expect(body).toMatch(/^## \[Unreleased\]$/m);
    expect(body).toMatch(/^### Added$/m);
    expect(body).toMatch(/^## \[0\.3\.0\] - 2026-09-20$/m);
    // The 0.2.0 entry stays as history, and says it never shipped — a customer
    // on v0.1.6 must not go looking for a tag that was never pushed.
    expect(body).toMatch(/^## \[0\.2\.0\] - 2026-05-05$/m);
    expect(body).toMatch(/> ⚠️ \*\*Never tagged\.\*\*/);
    expect(body).toMatch(/^### Migrating from v0\.1\.6$/m);
    expect(body).toContain('`ListOwners(ctx)`');
    expect(body).toContain('**`client.CryptoOrders`**');
    expect(body).toContain('`Quote`, `CreateCheckout`');
    expect(body).toMatch(/forward-compatible `map\[string\]any` envelopes/);
    expect(body).toMatch(
      /Crypto payments are not\s*refundable, and cancelling only works while an order is pending\./,
    );
    expect(body).toContain('`SendTest`');
    expect(body).toMatch(/a synthetic `test\.ping` delivery/);
    expect(body).toContain('**`client.AuditLog`**');
    expect(body).toContain('`Export(ctx)`');
    expect(body).toMatch(/up to 10,000 rows/);
    expect(body).toContain('`CliAuthorizeInitiate`');
    expect(body).toContain('`CliAuthorizeExchange`');
    expect(existsSync(P('sdk-go/CHANGELOG.md'))).toBe(true);
  });

  it('sdk-typescript/CHANGELOG.md: Keep-a-Changelog 1.1.0 + SemVer 2.0.0 + a fresh [Unreleased] above the dated 0.2.0 entry + the nothing-was-removed claim + team owners + webhook send-test/update + audit-log export (10,000 rows) + the CLI activation flow + profile snapshots', () => {
    const body = read(P('sdk-typescript/CHANGELOG.md'));
    expect(body).toMatch(/^# Changelog$/m);
    expect(body).toMatch(/All notable changes to the Driftstack TypeScript SDK\./);
    expect(body).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
    expect(body).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    expect(body).toMatch(/^## \[Unreleased\]$/m);
    expect(body).toMatch(/^## \[0\.2\.0\] - 2026-09-20$/m);
    // The claim the MINOR makes, in the entry that makes it.
    expect(body).toMatch(/\*\*Nothing was removed\.\*\*/);
    expect(body).toContain('`listOwners()`');
    expect(body).toContain('`sendTest(id)`');
    expect(body).toMatch(/a synthetic `test\.ping` delivery/);
    expect(body).toContain('`update(id, body)`');
    expect(body).toContain('**`client.auditLog`**');
    expect(body).toContain('`export()`');
    expect(body).toMatch(/up to 10,000 rows/);
    expect(body).toContain('`cliAuthorizeInitiate`');
    expect(body).toContain('`cliAuthorizeExchange`');
    expect(body).toContain('**`client.profileSnapshots`**');
    expect(body).toMatch(/immutable point-in-time copies of a/);
    expect(existsSync(P('sdk-typescript/CHANGELOG.md'))).toBe(true);
  });

  it('sdk-python/CHANGELOG.md: Keep-a-Changelog 1.1.0 + SemVer 2.0.0 + a fresh [Unreleased] above the dated 0.2.0 entry + the both-clients claim + team owners + crypto orders (idempotency key, non-refundable) + webhook send-test/update + audit-log export (10,000 rows) + the CLI activation flow', () => {
    const body = read(P('sdk-python/CHANGELOG.md'));
    expect(body).toMatch(/^# Changelog$/m);
    expect(body).toMatch(/All notable changes to the `driftstack` Python SDK\./);
    expect(body).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
    expect(body).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    expect(body).toMatch(/^## \[Unreleased\]$/m);
    expect(body).toMatch(/^## \[0\.2\.0\] - 2026-09-20$/m);
    expect(body).toMatch(/\*\*Nothing was removed\.\*\*/);
    // Every addition exists on both clients — the claim a Python customer on
    // the async client depends on.
    expect(body).toMatch(/on \*\*both\*\* `Driftstack` and `AsyncDriftstack`/);
    expect(body).toContain('`list_owners()`');
    expect(body).toContain('**`client.crypto_orders`**');
    expect(body).toContain('`idempotency_key=`');
    expect(body).toMatch(/Crypto payments are not refundable/);
    expect(body).toContain('`send_test()`');
    expect(body).toContain('`update()`');
    expect(body).toContain('**`client.audit_log`**');
    expect(body).toContain('`export()`');
    expect(body).toMatch(/up to 10,000 rows/);
    expect(body).toContain('`cli_authorize_initiate`');
    expect(body).toContain('`cli_authorize_exchange`');
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
