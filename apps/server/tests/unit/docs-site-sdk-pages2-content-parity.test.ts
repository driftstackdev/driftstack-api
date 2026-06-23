// W602 — drift guard for apps/docs/src/pages/sdk: installation + error-handling.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INSTALL = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');
const ERR = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/error-handling.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W602 apps/docs/sdk close-out pages content parity', () => {
  it('installation.md: OpenAPI 3.1 single source + 3-language sections (TS published + Python alpha PyPI-pending + Go alpha) + Node >=18 native fetch + Python 3.10+ + Go 1.22+ + per-language resource catalogue + DriftstackError base class + zero-non-stdlib-runtime-deps for Go pinned', () => {
    const body = read(INSTALL);
    expect(body).toMatch(/^title: SDK installation$/m);
    expect(body).toMatch(/^# SDK installation$/m);
    expect(body).toMatch(
      /The Driftstack SDKs share a typed surface generated from the same OpenAPI 3\.1 contract\./,
    );
    expect(body).toMatch(/^## TypeScript \/ Node\.js$/m);
    expect(body).toMatch(/\*\*Status:\*\* published on npm\./);
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/pnpm add @driftstack\/sdk/);
    expect(body).toMatch(/yarn add @driftstack\/sdk/);
    expect(body).toMatch(/\*\*Requirements:\*\* Node\.js ≥ 18 \(uses native `fetch`\)\./);
    expect(body).toMatch(
      /Works in any modern runtime exposing `fetch` and `node:crypto` \(Bun, Deno via npm specifier\)\./,
    );
    expect(body).toMatch(/baseUrl: 'https:\/\/api\.driftstack\.dev', \/\/ optional override/);
    expect(body).toMatch(/timeoutMs: 30_000,/);
    expect(body).toMatch(/maxAttempts: 3,/);
    expect(body).toMatch(/initialDelayMs: 200,/);
    expect(body).toMatch(/maxDelayMs: 10_000,/);
    expect(body).toMatch(/client\.sessions\.create\(body\?\);/);
    expect(body).toMatch(/client\.profileSnapshots\.restore\(snapshotId, body\?\);/);
    expect(body).toMatch(/client\.apiKeys\.rotate\(id\); \/\/ 24-hour grace on prior key/);
    expect(body).toMatch(/client\.webhooks\.rotateSecret\(id\); \/\/ 24h grace dual-sign/);
    expect(body).toMatch(/client\.webhooks\.sendTest\(id\); \/\/ synthetic test\.ping/);
    expect(body).toMatch(/client\.auth\.cliAuthorizeInitiate\(body\); \/\/ CLI\/GUI activation/);
    expect(body).toMatch(/client\.auditLog\.export\(\); \/\/ GDPR Article 20 JSON/);
    expect(body).toMatch(/\*\*Errors:\*\* every error extends `DriftstackError`\./);
    expect(body).toMatch(/^## Python$/m);
    expect(body).toMatch(/\*\*Status:\*\* alpha\. The SDK is built, tested, and wheel-buildable\./);
    expect(body).toMatch(/The dist name is `driftstack-sdk`; the import name is `driftstack`\./);
    expect(body).toMatch(/\*\*Requirements:\*\* Python 3\.10\+/);
    expect(body).toMatch(
      /Inputs accept either a Pydantic model OR a plain `dict`\. Outputs are typed Pydantic models\./,
    );
    expect(body).toMatch(/^## Go$/m);
    expect(body).toMatch(
      /\*\*Requirements:\*\* Go 1\.22\+ \(the toolchain floor declared in `go\.mod`\)\./,
    );
    expect(body).toMatch(
      /The Go SDK is single-package, has zero non-stdlib runtime dependencies, and is context-aware throughout\./,
    );
    expect(body).toMatch(/^## Versioning across SDKs$/m);
    expect(body).toMatch(/The HTTP API and the SDKs version independently\./);
    expect(body).toMatch(/^## What ships$/m);
    expect(body).toMatch(
      /\| Sessions\s+\| ✅\s+\| ✅\s+\| ✅\s+\| Full CRUD \+ navigate\/interact\/wait\/capture\/getState\s+\|/,
    );
    expect(body).toMatch(
      /\| API keys\s+\| ✅\s+\| ✅\s+\| ✅\s+\| Includes `rotate` with 24h grace\s+\|/,
    );
    expect(body).toMatch(
      /\| Team RBAC\s+\| ✅\s+\| ✅\s+\| ✅\s+\| Invite\/accept\/list\/remove\s+\|/,
    );
    expect(existsSync(INSTALL)).toBe(true);
  });

  it('error-handling.md: RFC 7807 problem+json mapping + single source PROBLEM_TYPE_TO_ERROR per lang from server OpenAPI + stable URI host errors.driftstack.dev + dispatch-on-slug-not-status + 15-row class-catalogue (3-language matrix + retryable column) + default retry policy (3 retries + exp backoff full jitter + Retry-After honoured) pinned', () => {
    const body = read(ERR);
    expect(body).toMatch(/^title: SDK error handling$/m);
    expect(body).toMatch(/^# SDK error handling$/m);
    expect(body).toMatch(/Every Driftstack SDK ships a typed error hierarchy mapping/);
    expect(body).toMatch(/`application\/problem\+json` responses \(RFC 7807\) to language-native/);
    expect(body).toMatch(/exceptions\./);
    expect(body).toMatch(/The hierarchy is consistent across TypeScript \/ Python \/ Go — the/);
    expect(body).toMatch(/type names \+ URI mapping are kept in sync via a single source of/);
    expect(body).toMatch(/truth \(`PROBLEM_TYPE_TO_ERROR` per language, generated against the/);
    expect(body).toMatch(/server's OpenAPI 3\.1 spec\)\./);
    expect(body).toMatch(/^## Hierarchy$/m);
    expect(body).toMatch(/`https:\/\/errors\.driftstack\.dev\/<slug>` host/);
    expect(body).toMatch(/Dispatch on the slug,/);
    expect(body).toMatch(/not on HTTP status\./);
    expect(body).toMatch(
      /\| `rate-limited`\s+\| `RateLimitError`\s+\| `RateLimitError`\s+\| `\*RateLimitError`\s+\| yes\s+\|/,
    );
    expect(body).toMatch(
      /\| `concurrency-limit`\s+\| `ConcurrencyLimitError`\s+\| `ConcurrencyLimitError`\s+\| `\*ConcurrencyLimitError`\s+\| no\s+\|/,
    );
    // TS uses TierLimitError (historical 0.1.x name); Python + Go use QuotaExceededError.
    expect(body).toMatch(
      /\| `tier-limit`\s+\| `TierLimitError`\s+\| `QuotaExceededError`\s+\| `\*QuotaExceededError`\s+\| no\s+\|/,
    );
    expect(body).toMatch(/\| `legal-acceptance-required`/);
    expect(body).toMatch(/\| `session-destroyed`/);
    expect(body).toMatch(/\| `session-timeout`/);
    expect(body).toMatch(
      /\| transport \(network \/ parse \/ timeout\) \| `TransportError`\s+\| `TransportError`\s+\| `\*TransportError`\s+\| yes\s+\|/,
    );
    expect(body).toMatch(/All extend `DriftstackError` \(TS\) \/ `DriftstackError` \(Python\) \//);
    expect(body).toMatch(/`\*DriftstackError` \(Go base struct embedded in every typed error\)\./);
    expect(body).toMatch(/^## TypeScript$/m);
    expect(body).toMatch(/import \{/);
    expect(body).toMatch(/ {2}Driftstack,/);
    expect(body).toMatch(/ {2}DriftstackError,/);
    expect(body).toMatch(/if \(err instanceof RateLimitError\) \{/);
    expect(body).toMatch(/await sleep\(\(err\.retryAfterSeconds \?\? 1\) \* 1000\);/);
    expect(body).toMatch(/The default retry policy \(3 retries, exponential backoff with full/);
    expect(body).toMatch(/jitter, honours `Retry-After`\) handles `TransportError` \+/);
    expect(body).toMatch(/`RateLimitError` automatically\./);
    expect(body).toMatch(/^## Python$/m);
    expect(body).toMatch(/from driftstack import \(/);
    expect(existsSync(ERR)).toBe(true);
  });
});
