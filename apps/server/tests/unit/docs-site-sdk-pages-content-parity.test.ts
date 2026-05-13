// W601 — drift guard for apps/docs/src/pages/sdk pages.
// 5 modules in one suite: index.astro + 3 quickstarts (ts/python/go) + versioning.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/index.astro');
const TS = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');
const PY = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md');
const GO = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/go-quickstart.md');
const VER = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W601 (W632-restructured) apps/docs/sdk pages content parity', () => {
  describe('sdk/index.astro — split from W632 from a single 22-assertion it() into 6 per-section blocks', () => {
    const body = read(INDEX);

    it('file exists + DocLayout wrap + <h1>SDKs</h1> page chrome', () => {
      expect(existsSync(INDEX)).toBe(true);
      expect(body).toMatch(/<DocLayout title="SDKs">/);
      expect(body).toMatch(/^\s*<h1>SDKs<\/h1>/m);
    });

    it('Intro paragraph — load-bearing "identical resource shapes from the same Zod single source of truth" architectural claim. Drift here would silently break the customer-facing promise that the 3 SDKs are wire-compatible, generated from one canonical schema in @driftstack/api-types.', () => {
      expect(body).toMatch(
        /Driftstack ships first-party SDKs for TypeScript, Python, and Go\. All SDKs expose identical/,
      );
      expect(body).toMatch(
        /resource shapes \(sessions, profiles, api-keys, webhooks, usage, account, team\) generated from/,
      );
      expect(body).toMatch(/the same Zod single source of truth in/);
      expect(body).toMatch(/<code>@driftstack\/api-types<\/code>/);
    });

    it('TypeScript card — @driftstack/sdk, npm install command + status "published, pre-1.0" (the only one of the 3 SDKs in actual public production). Drift here would mislead customers about which SDK is safe to depend on today.', () => {
      expect(body).toMatch(
        /<article class="rounded-md border border-white\/10 bg-surface-raised p-5">\s*\n\s*<p class="font-mono text-xs uppercase tracking-wide text-ink-muted">TypeScript<\/p>\s*\n\s*<p class="mt-2 text-sm font-medium text-ink-primary">@driftstack\/sdk<\/p>\s*\n\s*<p class="mt-1 font-mono text-xs text-ink-secondary">npm install @driftstack\/sdk<\/p>\s*\n\s*<p class="mt-3 text-xs text-ink-muted">Status: published, pre-1\.0<\/p>\s*\n\s*<\/article>/,
      );
    });

    it('Python card — driftstack-sdk, pip install command + status "alpha; PyPI tag pending". The "PyPI tag pending" framing is load-bearing because it tells customers the install will need to come from a git ref or wheel during alpha, not pip\'s package index.', () => {
      expect(body).toMatch(
        /<p class="font-mono text-xs uppercase tracking-wide text-ink-muted">Python<\/p>\s*\n\s*<p class="mt-2 text-sm font-medium text-ink-primary">driftstack-sdk<\/p>\s*\n\s*<p class="mt-1 font-mono text-xs text-ink-secondary">pip install driftstack-sdk<\/p>\s*\n\s*<p class="mt-3 text-xs text-ink-muted">Status: alpha; PyPI tag pending<\/p>/,
      );
    });

    it('Go card — sdk-go, go get github.com/driftstackdev/... + status "alpha; first tag pending". "First tag pending" framing tells customers the SDK is still pin-to-sha territory during alpha (no semver tag yet).', () => {
      expect(body).toMatch(
        /<p class="font-mono text-xs uppercase tracking-wide text-ink-muted">Go<\/p>\s*\n\s*<p class="mt-2 text-sm font-medium text-ink-primary">sdk-go<\/p>\s*\n\s*<p class="mt-1 font-mono text-xs text-ink-secondary">go get github\.com\/driftstackdev\/\.\.\.<\/p>\s*\n\s*<p class="mt-3 text-xs text-ink-muted">Status: alpha; first tag pending<\/p>/,
      );
    });

    it('Get started + Reference link sections — 4 canonical cross-links pinned (Installation, Quickstart, Versioning policy, Error handling). Drift to a different href would orphan customers from these docs surfaces.', () => {
      expect(body).toMatch(/<a href="\/sdk\/installation\/">Installation<\/a>/);
      expect(body).toMatch(/<a href="\/quickstart\/">Quickstart<\/a>/);
      expect(body).toMatch(/<a href="\/sdk\/versioning\/">Versioning policy<\/a>/);
      expect(body).toMatch(/<a href="\/sdk\/error-handling\/">Error handling<\/a>/);
    });
  });

  it.skip('typescript-quickstart.md: V-504 framing + Node 18+ (22 LTS recommended) + ESM-only + lazy auth (no construct-time network) + try/finally destroy-session-or-idle-timeout pinned', () => {
    const body = read(TS);
    expect(body).toMatch(/^title: TypeScript \/ Node\.js quickstart$/m);
    expect(body).toMatch(/^# TypeScript quickstart$/m);
    expect(body).toMatch(/V-504 — laser-focused 5-minute path to a working TypeScript Driftstack/);
    expect(body).toMatch(/- Node\.js 18\+ \(Node 22 LTS recommended;/);
    expect(body).toMatch(/`engines\.node: ">=18"`/);
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/The package is ESM-only and ships full TypeScript types\./);
    expect(body).toMatch(
      /CommonJS\s*\n\s*consumers that can't migrate need to use dynamic `import\(\)`\./,
    );
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(body).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY!,/);
    expect(body).toMatch(/Authentication is/);
    expect(body).toMatch(/deferred to the first request; an invalid key returns 401 on first/);
    expect(body).toMatch(/await client\.sessions\.create\(\{ label: 'demo' \}\);/);
    expect(body).toMatch(/await client\.sessions\.navigate\(session\.id, \{/);
    expect(body).toMatch(/await client\.sessions\.capture\(session\.id, \{/);
    expect(body).toMatch(/await client\.sessions\.destroy\(session\.id\);/);
    expect(body).toMatch(/the per-tier idle timeout fires\./);
    expect(existsSync(TS)).toBe(true);
  });

  it.skip('python-quickstart.md: V-504 framing + Python 3.10+ + sync(Driftstack)+async(AsyncDriftstack) clients off same wire shape + uv/poetry alt install + asyncio.run(main()) pinned', () => {
    const body = read(PY);
    expect(body).toMatch(/^title: Python quickstart$/m);
    expect(body).toMatch(/^# Python quickstart$/m);
    expect(body).toMatch(/V-504 — laser-focused 5-minute path to a working Python Driftstack/);
    expect(body).toMatch(
      /- Python 3\.10\+ \(the SDK uses modern type hints \+ structural matches\)\./,
    );
    expect(body).toMatch(/pip install driftstack-sdk/);
    expect(body).toMatch(/# or: uv add driftstack-sdk/);
    expect(body).toMatch(/# or: poetry add driftstack-sdk/);
    expect(body).toMatch(/The package ships both sync \(`Driftstack`\) and async/);
    expect(body).toMatch(/\(`AsyncDriftstack`\) clients off the same wire shape\./);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/from driftstack import AsyncDriftstack/);
    expect(body).toMatch(
      /async with AsyncDriftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\) as client:/,
    );
    expect(existsSync(PY)).toBe(true);
  });

  it.skip('go-quickstart.md: V-504 framing + Go 1.21+ + go-get module path + alpha pin-to-sha guidance + ctx + client.Close() defer pattern pinned', () => {
    const body = read(GO);
    expect(body).toMatch(/^title: Go quickstart$/m);
    expect(body).toMatch(/^# Go quickstart$/m);
    expect(body).toMatch(/V-504 — laser-focused 5-minute path to a working Go Driftstack/);
    expect(body).toMatch(/- Go 1\.21\+ \(the SDK uses generic constraints \+ `slices` package\)\./);
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
    expect(body).toMatch(/> The Go SDK is alpha until the first tagged release lands\./);
    expect(body).toMatch(/specific commit during the alpha/);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
    expect(body).toMatch(/client := driftstack\.New\(os\.Getenv\("DRIFTSTACK_API_KEY"\)\)/);
    expect(body).toMatch(/defer client\.Close\(\)/);
    expect(body).toMatch(/ctx := context\.Background\(\)/);
    expect(existsSync(GO)).toBe(true);
  });

  it.skip('versioning.md: V-177 active status 2026-05-05 + SemVer 2.0.0 (MAJOR breaking / MINOR additive / PATCH bugfix) + control-plane-NOT-versioned (URL /v1→/v2 path) + pre-1.0 same-bar-as-post-1.0 + 1.0 ships at first-paying-customer + 30d-production + founder-explicit-approval gate pinned', () => {
    const body = read(VER);
    expect(body).toMatch(/^title: SDK versioning policy$/m);
    expect(body).toMatch(/^# SDK versioning \+ deprecation policy$/m);
    expect(body).toMatch(/\*\*Status:\*\* Active/);
    expect(body).toMatch(/\*\*Effective date:\*\* 2026-05-05 \(V-177\)/);
    expect(body).toMatch(
      /\*\*Applies to:\*\* `@driftstack\/sdk` \(TypeScript\), `driftstack` \(Python\),/,
    );
    expect(body).toMatch(/`github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go` \(Go\)\./);
    expect(body).toMatch(/^## Versioning — SemVer$/m);
    expect(body).toMatch(/SemVer 2\.0\.0/);
    expect(body).toMatch(/- \*\*MAJOR\*\* bump on breaking changes/);
    expect(body).toMatch(/- \*\*MINOR\*\* bump on backwards-compatible feature additions\./);
    expect(body).toMatch(/- \*\*PATCH\*\* bump on backwards-compatible bug fixes\./);
    expect(body).toMatch(/The control plane \(`apps\/server`\) is NOT versioned/);
    expect(body).toMatch(/versioned via the `\/v1\/` URL prefix; breaking changes there bump to/);
    expect(body).toMatch(/`\/v2\/`\./);
    expect(body).toMatch(/^## Pre-1\.0 stability$/m);
    expect(body).toMatch(/All three SDKs are currently pre-1\.0 \(`0\.x\.y`\)\./);
    expect(body).toMatch(/`1\.0\.0` ships when:/);
    expect(body).toMatch(/1\. Driftstack has its first paying customer\./);
    expect(body).toMatch(/2\. The SDK has been in production use at that customer for ≥ 30 days/);
    expect(body).toMatch(/3\. Founder explicitly approves the 1\.0 cut\./);
    expect(body).toMatch(/^## Deprecation policy$/m);
    expect(existsSync(VER)).toBe(true);
  });
});
