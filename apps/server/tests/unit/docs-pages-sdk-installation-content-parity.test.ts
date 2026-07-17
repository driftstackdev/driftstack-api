// W778 — apps/docs sdk/installation.md content parity. One-hundred-
// fourth in the cross-SDK drift-guard series.
//
// /sdk/installation is the canonical 3-SDK install + configuration
// reference. Drift to package names, status badges, or the cross-
// SDK capability matrix would mismatch W775 SDK landing-page + the
// SDK versioning policy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');

describe('W778 docs /sdk/installation content parity', () => {
  it('sdk/installation.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: SDK installation\n/,
    );
    expect(p).toMatch(
      /description: Installation and configuration for the Driftstack TypeScript, Python, and Go SDKs\./,
    );
  });

  it("CRITICAL OpenAPI 3.1 typed-surface framing pinned. The 'The Driftstack SDKs share a typed surface generated from the same OpenAPI 3.1 contract' wording matches W775 SDK index Zod-source-of-truth.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The Driftstack SDKs share a typed surface generated from the same OpenAPI 3\.1 contract\./,
    );
  });

  it('CRITICAL TS 3-installer set pinned — npm/pnpm/yarn. Drift would let SDK adopters miss their package manager.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/npm install @driftstack\/sdk/);
    expect(p).toMatch(/pnpm add @driftstack\/sdk/);
    expect(p).toMatch(/yarn add @driftstack\/sdk/);
  });

  it("CRITICAL TS Node-18+ + fetch+node:crypto requirements pinned. The 'Works in any modern runtime exposing fetch and node:crypto (Bun, Deno via npm specifier)' wording explains the runtime portability claim.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Node\.js ≥ 18 \(uses native `fetch`\)/);
    expect(p).toMatch(
      /Works in any modern runtime exposing `fetch` and `node:crypto` \(Bun, Deno via npm specifier\)\./,
    );
  });

  it('CRITICAL TS Driftstack({apiKey, baseUrl, timeoutMs, retry}) constructor shape pinned. Drift to a different option name would break SDK consumer configuration.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY!,/);
    expect(p).toMatch(/baseUrl: 'https:\/\/api\.driftstack\.dev'/);
    expect(p).toMatch(/timeoutMs: 30_000,/);
    expect(p).toMatch(/maxAttempts: 3,/);
    expect(p).toMatch(/initialDelayMs: 200,/);
    expect(p).toMatch(/maxDelayMs: 10_000,/);
  });

  it('CRITICAL TS resource catalog pinned — 16 resources matching the W775 SDK-index identical-resource-shapes claim. Drift to dropping a resource would silently break SDK consumers.', () => {
    const p = read(PAGE);

    // Top-level resources.
    const resources = [
      'client.sessions',
      'client.profiles',
      'client.profileSnapshots',
      'client.apiKeys',
      'client.webhooks',
      'client.auth',
      'client.auditLog',
      'client.legal',
      'client.mfa',
      'client.team',
      'client.emailPreferences',
      'client.billing',
      'client.cryptoOrders',
      'client.usage',
      'client.account',
    ];
    for (const res of resources) {
      expect(p, `resource ${res}`).toMatch(new RegExp(`${res.replace(/\./g, '\\.')}\\.`));
    }
  });

  it('CRITICAL TS sessions 9-action catalog pinned — create/list/iterate/navigate/interact/wait/getState/capture/destroy. Matches W761 /api/sessions 6-action lifecycle + list+iterate convenience.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.sessions\.create\(body\?\);/);
    expect(p).toMatch(/client\.sessions\.list\(query\?\);/);
    expect(p).toMatch(/client\.sessions\.iterate\(opts\?\);/);
    expect(p).toMatch(/client\.sessions\.navigate\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.interact\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.wait\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.getState\(id\);/);
    expect(p).toMatch(/client\.sessions\.capture\(id, body\);/);
    expect(p).toMatch(/client\.sessions\.destroy\(id\);/);
  });

  it('CRITICAL TS apiKeys 24h-grace + admin-scope framing pinned. Matches W762 /api/api-keys + W766 /api/team role-gating contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.apiKeys\.create\(body\); \/\/ requires account_owner scope/);
    expect(p).toMatch(/client\.apiKeys\.rotate\(id\); \/\/ 24-hour grace on prior key/);
    expect(p).toMatch(/client\.apiKeys\.revoke\(id\); \/\/ requires account_owner scope/);
  });

  it('CRITICAL TS webhooks rotateSecret 24h-grace-dual-sign framing pinned. Matches W753 dashboard /webhooks + W766 /api/team header-honoring + V-475 dual-sign contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.webhooks\.rotateSecret\(id\); \/\/ 24h grace dual-sign/);
    expect(p).toMatch(/client\.webhooks\.sendTest\(id\); \/\/ synthetic test\.ping/);
  });

  it('CRITICAL TS profileSnapshots 7-action catalog pinned. Matches W774 /api/profile-snapshots 5-endpoint set + iterate convenience.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.profileSnapshots\.capture\(profileId, body\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.listForProfile\(profileId, query\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.list\(query\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.iterate\(opts\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.get\(snapshotId\);/);
    expect(p).toMatch(/client\.profileSnapshots\.restore\(snapshotId, body\?\);/);
    expect(p).toMatch(/client\.profileSnapshots\.delete\(snapshotId\);/);
  });

  it('CRITICAL TS auth.cli-authorize 3-step pinned — initiate/bind/exchange. Matches W764 /api/auth CLI activation flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.auth\.cliAuthorizeInitiate\(body\); \/\/ CLI\/GUI activation/);
    expect(p).toMatch(/client\.auth\.cliAuthorizeBind\(body\);/);
    expect(p).toMatch(/client\.auth\.cliAuthorizeExchange\(body\);/);
    expect(p).toMatch(/client\.auth\.mfaChallenge\(body\); \/\/ login MFA exchange/);
    expect(p).toMatch(/client\.auth\.mfaStepUp\(body\); \/\/ step-up freshness/);
  });

  it("CRITICAL TS auditLog 3-action pinned — list/iterate/export. The 'GDPR Article 20 JSON' comment matches W768 audit-log export framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/client\.auditLog\.list\(query\?\);/);
    expect(p).toMatch(/client\.auditLog\.iterate\(opts\?\);/);
    expect(p).toMatch(/client\.auditLog\.export\(\); \/\/ GDPR Article 20 JSON/);
  });

  it("CRITICAL DriftstackError + 4-subclass error-framing pinned. The 'every error extends DriftstackError. Catch the base for blanket handling, or specific subclasses (RateLimitError, ConcurrencyLimitError, ValidationError, AuthError) for granular logic' wording matches W776 /sdk/error-handling categorical-catch contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /every error extends `DriftstackError`\. Catch the base for blanket handling, or specific subclasses \(`RateLimitError`, `ConcurrencyLimitError`, `ValidationError`, `AuthError`\) for granular logic\./,
    );
  });

  it('CRITICAL Python PyPI pre-1.0 install, reproducibility, and distribution/import names pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The distribution name is `driftstack-sdk`; the import name is `driftstack`\./,
    );
    expect(p).toMatch(/\*\*Status:\*\* published on PyPI, pre-1\.0, and classified Alpha\./);
    expect(p).toMatch(/^pip install driftstack-sdk$/m);
    expect(p).toMatch(/Use requirements constraints or a lockfile for reproducible deployments/);
    expect(p).not.toMatch(/@<commit>#subdirectory=packages\/sdk-python|source commit/);
  });

  it('CRITICAL Python 3.10+ + sync+async dual-client framing pinned. Driftstack (sync) + AsyncDriftstack (async) with context-manager idiom matches the V-452 SDK idioms.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Python 3\.10\+\./);
    expect(p).toMatch(/from driftstack import Driftstack/);
    expect(p).toMatch(/from driftstack import AsyncDriftstack/);
    expect(p).toMatch(/with Driftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\) as client:/);
    expect(p).toMatch(
      /async with AsyncDriftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\) as client:/,
    );
  });

  it('CRITICAL Python resource-table pinned with 13 accessors. Drift to dropping a row would break SDK consumer typings.', () => {
    const p = read(PAGE);

    for (const accessor of [
      'client.sessions',
      'client.profiles',
      'client.api_keys',
      'client.usage',
      'client.webhooks',
      'client.team',
      'client.account',
      'client.auth',
      'client.audit_log',
      'client.mfa',
      'client.email_preferences',
      'client.legal',
      'client.profile_snapshots',
    ]) {
      expect(p, `accessor ${accessor}`).toMatch(
        new RegExp(`\\| \`${accessor.replace(/\./g, '\\.')}\``),
      );
    }
  });

  it("CRITICAL Python pydantic-OR-dict input + typed-Pydantic-output framing pinned. The 'Inputs accept either a Pydantic model OR a plain dict. Outputs are typed Pydantic models' wording is the load-bearing Python idiom.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Inputs accept either a Pydantic model OR a plain `dict`\. Outputs are typed Pydantic models\./,
    );
  });

  it("CRITICAL Go 1.22+ + zero-non-stdlib-runtime-deps framing pinned. The 'The Go SDK is single-package, has zero non-stdlib runtime dependencies, and is context-aware throughout' wording matches Go-stdlib-only design constraint.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Go 1\.22\+ \(the toolchain floor declared in `go\.mod`\)/);
    expect(p).toMatch(
      /The Go SDK is single-package, has zero non-stdlib runtime dependencies, and is context-aware throughout\./,
    );
  });

  it('CRITICAL tagged Go install and go.mod/go.sum reproducibility are pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go@latest/);
    expect(p).toMatch(/\*\*Status:\*\* published as a tagged pre-1\.0 module\./);
    expect(p).toMatch(/Commit `go\.mod` and `go\.sum` for reproducible deployments/);
    expect(p).not.toMatch(/@<commit>|pseudo-version|first tag pending/i);
  });

  it('CRITICAL Go driftstack.New + defer client.Close() framing pinned. The constructor + cleanup idiom is the canonical Go-SDK resource-management.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/client := driftstack\.New\(os\.Getenv\("DRIFTSTACK_API_KEY"\)\)/);
    expect(p).toMatch(/defer client\.Close\(\)/);
    expect(p).toMatch(/me, err := client\.Account\.Me\(ctx\)/);
  });

  it("CRITICAL versioning-independence framing pinned. The 'SDKs at any version stay compatible with the live API contract; SDK upgrades unlock newer fields and new resource methods, but won\\'t break older method calls' wording matches W777 SDK versioning policy.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /SDKs at any version stay compatible with the live API contract; SDK upgrades unlock newer fields and new resource methods, but won't break older method calls\./,
    );
  });

  it('CRITICAL 7-row What-ships capability-matrix pinned. Sessions/Profiles/API keys/Webhooks/Team RBAC/Usage/Account self — all 3 SDKs (TS/Python/Go) marked ✅. Drift would let customer expectations diverge from shipped capability.', () => {
    const p = read(PAGE);

    for (const cap of [
      'Sessions',
      'Profiles',
      'API keys',
      'Webhooks',
      'Team RBAC',
      'Usage',
      'Account self',
    ]) {
      expect(p, `capability row ${cap}`).toMatch(new RegExp(`\\| ${cap}\\s+\\| ✅`));
    }
  });

  it('CRITICAL Next-steps 3-link set pinned — /quickstart/ + /guides/profile-management/ + /guides/session-lifecycle/. Drift to dropping any link would force new customers to hunt for follow-on content.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*\[Quickstart\]\(\/quickstart\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Profile management\]\(\/guides\/profile-management\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Session lifecycle\]\(\/guides\/session-lifecycle\/\)\*\*/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-sdk-installation-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
