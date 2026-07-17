// W775 — apps/docs sdk/index.astro content parity. One-hundred-first
// in the cross-SDK drift-guard series. Opens the apps/docs/sdk/
// subtree sweep.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/index.astro');

describe('W775 docs /sdk index content parity', () => {
  it('sdk/index.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("CRITICAL 3-SDK + identical-resource-shapes framing pinned. The 'Driftstack ships first-party SDKs for TypeScript, Python, and Go. All SDKs expose identical resource shapes (sessions, profiles, api-keys, webhooks, usage, account, team) generated from the same Zod single source of truth in @driftstack/api-types' wording is the load-bearing cross-SDK contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack ships first-party SDKs for TypeScript, Python, and Go\./);
    expect(p).toMatch(
      /All SDKs expose identical\s*\n\s+resource shapes \(sessions, profiles, api-keys, webhooks, usage, account, team\) generated from/,
    );
    expect(p).toMatch(/the same Zod single source of truth in/);
    expect(p).toMatch(/<code>@driftstack\/api-types<\/code>/);
  });

  it('CRITICAL 3-language card set pinned with install commands. npm install @driftstack/sdk + pip install driftstack-sdk + go get github.com/driftstackdev/... Drift to a different package name would break SDK adopters.', () => {
    const p = read(PAGE);

    // S22.1 (2026-07-06) — card ink migrated to tk tokens (text-tk-ink).
    expect(p).toMatch(/<p class="mt-2 text-sm font-medium text-tk-ink">@driftstack\/sdk<\/p>/);
    expect(p).toMatch(/npm install @driftstack\/sdk/);
    expect(p).toMatch(/<p class="mt-2 text-sm font-medium text-tk-ink">driftstack-sdk<\/p>/);
    expect(p).toMatch(/pip install driftstack-sdk/);
    expect(p).toMatch(/<p class="mt-2 text-sm font-medium text-tk-ink">sdk-go<\/p>/);
    expect(p).toMatch(/go get github\.com\/driftstackdev\/\.\.\./);
  });

  it('CRITICAL status badges pin all three published pre-1.0 packages without pending-registry fiction.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Status: published, pre-1\.0/);
    expect(p).toMatch(/Status: published on PyPI; pre-1\.0 Alpha/);
    expect(p).toMatch(/Status: published tagged module; pre-1\.0/);
    expect(p).not.toMatch(/PyPI tag pending|first tag pending|source install|source module/);
  });

  it("CRITICAL 'Get started' 2-link set pinned — /sdk/installation/ + /quickstart/. Drift to dropping either link would force new customers to hunt for getting-started content.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="\/sdk\/installation\/">Installation<\/a>/);
    expect(p).toMatch(/<a href="\/quickstart\/">Quickstart<\/a>/);
  });

  it("CRITICAL 'Reference' 2-link set pinned — /sdk/versioning/ + /sdk/error-handling/. Drift to dropping either link would force SDK consumers to hunt for the policy + error taxonomy.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="\/sdk\/versioning\/">Versioning policy<\/a>/);
    expect(p).toMatch(/<a href="\/sdk\/error-handling\/">Error handling<\/a>/);
  });

  it("CRITICAL versioning-independently-of-API framing pinned. The 'how SDKs version independently of the HTTP API, deprecation rules, CHANGELOG conventions' wording matches W772 /api/versioning distinct-from-SDK-versioning contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /how SDKs version independently of the\s*\n?\s+HTTP API, deprecation rules, CHANGELOG conventions\./,
    );
  });

  it("CRITICAL error-handling cross-SDK framing pinned. The 'typed error hierarchy across TypeScript / Python / Go SDKs; categorical try/catch patterns; retry semantics + cancellation' wording threads the 3-SDK identical-error-shape contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /typed error hierarchy across\s*\n?\s+TypeScript \/ Python \/ Go SDKs; categorical try\/catch patterns; retry semantics \+\s*\n?\s+cancellation\./,
    );
  });

  it("CRITICAL quickstart 'signup → first session in five minutes' framing pinned. Matches W760 /api index quickstart cross-reference.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/signup → first session in five minutes/);
  });

  it('CRITICAL DocLayout used with title="SDKs".', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import DocLayout from '\.\.\/\.\.\/layouts\/DocLayout\.astro'/);
    expect(p).toMatch(/<DocLayout title="SDKs">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-sdk-index-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
