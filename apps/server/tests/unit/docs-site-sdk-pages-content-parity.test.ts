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

    it('TypeScript card — @driftstack/sdk, npm install command + status "published, pre-1.0" (the only one of the 3 SDKs in actual public production). S22.1 (2026-07-06): card chrome re-pinned on tk-* tokens (tk-border/tk-surface/tk-ink ladder + ambient shadow). Drift here would mislead customers about which SDK is safe to depend on today.', () => {
      expect(body).toMatch(
        /<article class="rounded-md border border-tk-border bg-tk-surface p-5 shadow-ambient">\s*\n\s*<p class="font-mono text-xs uppercase tracking-wide text-tk-ink-3">TypeScript<\/p>\s*\n\s*<p class="mt-2 text-sm font-medium text-tk-ink">@driftstack\/sdk<\/p>\s*\n\s*<p class="mt-1 font-mono text-xs text-tk-ink-2">npm install @driftstack\/sdk<\/p>\s*\n\s*<p class="mt-3 text-xs text-tk-ink-3">Status: published, pre-1\.0<\/p>\s*\n\s*<\/article>/,
      );
    });

    it('Python card — source-install command + current pre-1.0 status, with no registry promise.', () => {
      expect(body).toMatch(
        /<p class="font-mono text-xs uppercase tracking-wide text-tk-ink-3">Python<\/p>\s*\n\s*<p class="mt-2 text-sm font-medium text-tk-ink">driftstack-sdk<\/p>\s*\n\s*<p class="mt-1 font-mono text-xs text-tk-ink-2">pip install …#subdirectory=packages\/sdk-python<\/p>\s*\n\s*<p class="mt-3 text-xs text-tk-ink-3">Status: source install; pre-1\.0<\/p>/,
      );
    });

    it('Go card — source-module command + current pre-1.0 status, with no future tag promise.', () => {
      expect(body).toMatch(
        /<p class="font-mono text-xs uppercase tracking-wide text-tk-ink-3">Go<\/p>\s*\n\s*<p class="mt-2 text-sm font-medium text-tk-ink">sdk-go<\/p>\s*\n\s*<p class="mt-1 font-mono text-xs text-tk-ink-2">go get github\.com\/driftstackdev\/\.\.\.<\/p>\s*\n\s*<p class="mt-3 text-xs text-tk-ink-3">Status: source module; pre-1\.0<\/p>/,
      );
    });

    it('Get started + Reference link sections — 4 canonical cross-links pinned (Installation, Quickstart, Versioning policy, Error handling). Drift to a different href would orphan customers from these docs surfaces.', () => {
      expect(body).toMatch(/<a href="\/sdk\/installation\/">Installation<\/a>/);
      expect(body).toMatch(/<a href="\/quickstart\/">Quickstart<\/a>/);
      expect(body).toMatch(/<a href="\/sdk\/versioning\/">Versioning policy<\/a>/);
      expect(body).toMatch(/<a href="\/sdk\/error-handling\/">Error handling<\/a>/);
    });
  });

  it('typescript-quickstart.md: laser-focused-5-minute framing + Node 18+ (22 LTS recommended) + ESM-only + lazy auth (no construct-time network) + try/finally destroy-session-or-idle-timeout pinned. Re-enabled by slice 318 after the R4 V-NNN scrub (commit b46b8d4124b) removed the V-504 anchor; the doc now leads with the bare em-dash form "— laser-focused..."', () => {
    const body = read(TS);
    expect(body).toMatch(/^title: TypeScript \/ Node\.js quickstart$/m);
    expect(body).toMatch(/^# TypeScript quickstart$/m);
    expect(body).toMatch(/^— laser-focused 5-minute path to a working TypeScript Driftstack$/m);
    expect(body).toMatch(/- Node\.js 18\+ \(Node 22 LTS recommended;/);
    expect(body).toMatch(/`engines\.node: ">=18"`/);
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    // 2026-06-24: @driftstack/sdk is dual-published (package.json main
    // ./dist/index.cjs + exports["."].require), NOT ESM-only.
    expect(body).toMatch(
      /The package is dual-published \(ESM \+ CommonJS via conditional\s*\n?`exports`\) and ships full TypeScript types\./,
    );
    expect(body).toMatch(
      /Both `import` and\s*\n?`require\('@driftstack\/sdk'\)` work out of the box\./,
    );
    expect(body).not.toMatch(/The package is ESM-only/);
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(body).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY!,/);
    expect(body).toMatch(/Authentication is/);
    expect(body).toMatch(/deferred to the first request; an invalid key returns 401 on first/);
    expect(body).toMatch(/await client\.sessions\.create\(\{ label: 'demo' \}\);/);
    expect(body).toMatch(/await client\.sessions\.navigate\(session\.id, \{/);
    expect(body).toMatch(/await client\.sessions\.capture\(session\.id, \{/);
    expect(body).toMatch(/await client\.sessions\.destroy\(session\.id\);/);
    // S36 2026-07-07 (fable-truth-audit): the per-tier idle timeout was
    // fictional — no idle timeout exists on any tier; only the free tier's
    // 20-minute duration cap auto-destroys.
    expect(body).toMatch(/There is no idle timeout on any tier/);
    expect(body).not.toMatch(/per-tier idle timeout/);
    expect(existsSync(TS)).toBe(true);
  });

  it('python-quickstart.md: laser-focused-5-minute framing + Python 3.10+ + sync(Driftstack)+async(AsyncDriftstack) clients off same wire shape + uv/poetry alt install + asyncio.run(main()) pinned. Re-enabled by slice 319 post the R4 V-NNN scrub (V-504 anchor removed; doc leads with bare em-dash)', () => {
    const body = read(PY);
    expect(body).toMatch(/^title: Python quickstart$/m);
    expect(body).toMatch(/^# Python quickstart$/m);
    expect(body).toMatch(/^— laser-focused 5-minute path to a working Python Driftstack$/m);
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

  it('go-quickstart.md: Go 1.22+, exact source pin, ctx + client.Close lifecycle pinned', () => {
    const body = read(GO);
    expect(body).toMatch(/^title: Go quickstart$/m);
    expect(body).toMatch(/^# Go quickstart$/m);
    expect(body).toMatch(/^— laser-focused 5-minute path to a working Go Driftstack$/m);
    expect(body).toMatch(/- Go 1\.22\+ \(the SDK uses generic constraints \+ `slices` package\)\./);
    expect(body).not.toMatch(/- Go 1\.21\+/);
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
    expect(body).toMatch(/> The Go SDK is pre-1\.0\. Replace `<commit>` with an exact commit SHA/);
    expect(body).toMatch(/production builds remain reproducible/);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
    expect(body).toMatch(/client := driftstack\.New\(os\.Getenv\("DRIFTSTACK_API_KEY"\)\)/);
    expect(body).toMatch(/defer client\.Close\(\)/);
    expect(body).toMatch(/ctx := context\.Background\(\)/);
    expect(existsSync(GO)).toBe(true);
  });

  it('versioning.md: active status + effective date + SemVer + HTTP/SDK split + explicit pre-1.0 compatibility guidance, without speculative launch promises', () => {
    const body = read(VER);
    expect(body).toMatch(/^title: SDK versioning policy$/m);
    expect(body).toMatch(/^# SDK versioning \+ deprecation policy$/m);
    expect(body).toMatch(/\*\*Status:\*\* Active/);
    expect(body).toMatch(/\*\*Effective date:\*\* 2026-05-05$/m);
    // S36 2026-07-07 (fable-truth-audit): the Python PyPI distribution name
    // is driftstack-sdk (pyproject.toml); `driftstack` is only the import name.
    expect(body).toMatch(
      /\*\*Applies to:\*\* `@driftstack\/sdk` \(TypeScript\), `driftstack-sdk`\s*\n?\(Python — that's the PyPI distribution name; the import name is\s*\n?`driftstack`\),/,
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
    expect(body).toMatch(
      /pre-1\.0\s*\n?breaks bump the MINOR version AND get explicit deprecation notice/,
    );
    expect(body).toMatch(/The bar is the same as post-1\.0/);
    expect(body).toMatch(/Customers integrating a pre-1\.0 SDK should pin a compatible version/);
    expect(body).not.toMatch(/first paying customer|first-paying-customer/i);
    expect(body).not.toMatch(/`1\.0\.0` ships when/);
    expect(body).not.toMatch(/founder.*approv/i);
    expect(body).toMatch(/^## Deprecation policy$/m);
    expect(existsSync(VER)).toBe(true);
  });
});
