// W777 — apps/docs sdk/versioning.md content parity. One-hundred-
// third in the cross-SDK drift-guard series.
//
// /sdk/versioning is the canonical V-177 SDK versioning + deprecation
// policy. Drift to the SemVer mapping, the pre-1.0 stability framing,
// or the cross-SDK lockstep contract would mismatch the W775 SDK
// landing-page promises and the V-177 effective date.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  goSdkVersion,
  nextMinor,
  pythonSdkVersion,
  typescriptSdkVersion,
} from './_helpers/sdk-versions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/versioning.md');

describe('W777 docs /sdk/versioning content parity', () => {
  it('sdk/versioning.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads SDK versioning + deprecation + independent of HTTP API.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: SDK versioning policy\n/,
    );
    expect(p).toMatch(
      /description: Driftstack SDK versioning and deprecation policy, independent of HTTP API versioning\./,
    );
  });

  it('CRITICAL Status + effective-date header pinned: "**Status:** Active" + "**Effective date:** 2026-05-05" — pinned so the canonical policy anchor survives. The previous skip pinned `(V-177)` inline anchor that was removed from the customer-rendered copy as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.io pages); the framing itself survives without it.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Status:\*\* Active/);
    expect(p).toMatch(/\*\*Effective date:\*\* 2026-05-05/);
    // Drift-guard: the internal V-177 anchor MUST NOT bleed back
    // into the customer-rendered effective-date header.
    expect(p).not.toMatch(/\*\*Effective date:\*\* 2026-05-05 \(V-177\)/);
  });

  it('CRITICAL 3-SDK applies-to set pinned — @driftstack/sdk (TS) + driftstack-sdk (Python dist name) + sdk-go (Go). S36 2026-07-07 (fable-truth-audit): the Python PyPI distribution is `driftstack-sdk` (packages/sdk-python/pyproject.toml name), `driftstack` is only the import name — pinning `driftstack` targets a different (potentially squatted) PyPI package. Matches installation.md + sdk/index.astro which state the correct dist name.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\*\*Applies to:\*\* `@driftstack\/sdk` \(TypeScript\), `driftstack-sdk`\s*\n?\(Python — that's the PyPI distribution name; the import name is\s*\n?`driftstack`\),/,
    );
    expect(p).toMatch(/`github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go` \(Go\)/);
  });

  it('CRITICAL SemVer 2.0.0 + 3-tier bump rules pinned. MAJOR=breaking + MINOR=backwards-compat additions + PATCH=backwards-compat fixes. Drift would mismatch sdk-CHANGELOG conventions.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /All three SDKs follow \[SemVer 2\.0\.0\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/,
    );
    expect(p).toMatch(/\*\*MAJOR\*\* bump on breaking changes/);
    expect(p).toMatch(/\*\*MINOR\*\* bump on backwards-compatible feature additions/);
    expect(p).toMatch(/\*\*PATCH\*\* bump on backwards-compatible bug fixes/);
  });

  it("CRITICAL server-not-SemVer-versioned framing pinned. The 'The Driftstack server itself is not versioned — its API is versioned via the /v1/ URL prefix; breaking changes there bump to /v2/. SDKs follow whichever API version they target' wording matches W772 /api/versioning distinct-from-SDK-versioning contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The Driftstack server itself is not versioned — its API is\s*\n?versioned via the `\/v1\/` URL prefix; breaking changes there bump to\s*\n?`\/v2\/`\. SDKs follow whichever API version they target\./,
    );
    expect(p).toMatch(/Today every\s*\n?SDK targets `\/v1\/`/);
  });

  it("CRITICAL pre-1.0-bar-equals-post-1.0-bar framing pinned. The 'We DO NOT take advantage of this — pre-1.0 breaks bump the MINOR version AND get explicit deprecation notice (see Deprecation policy below). The bar is the same as post-1.0' wording is the load-bearing customer-trust promise.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /We DO NOT take advantage of this — pre-1\.0\s*\n?breaks bump the MINOR version AND get explicit deprecation notice/,
    );
    expect(p).toMatch(/The bar is the same as post-1\.0;/);
  });

  it('CRITICAL pre-1.0 customers are told to pin a compatible version and read the CHANGELOG, at the version the package is about to publish.', () => {
    const p = read(PAGE);
    const ts = typescriptSdkVersion();

    expect(p).toMatch(
      /Customers integrating a pre-1\.0 SDK should pin a compatible version\s*\n?\(e\.g\., `\^[0-9]+\.[0-9]+\.[0-9]+`\) and read the CHANGELOG before bumping\./,
    );
    expect(p, `the pre-1.0 pin example must name the published version ${ts}`).toContain(
      `(e.g., \`^${ts}\`) and read the CHANGELOG before bumping.`,
    );
    expect(p).not.toMatch(/`1\.0\.0` ships when|first paying customer/);
  });

  it('CRITICAL 3-language @deprecated annotation framing pinned. JSDoc @deprecated + Python DeprecationWarning + Go doc-comment // Deprecated:. Each SDK runtime emits a one-time deprecation warning on first use except Go (doc-only, noise-avoidance).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Adding `@deprecated` JSDoc \/ Python `DeprecationWarning` \/ Go/);
    expect(p).toMatch(/doc-comment `\/\/ Deprecated:` to the symbol in the SDK source\./);
    expect(p).toMatch(
      /SDK runtime emits a one-time deprecation warning on first use\s*\n?\s+\(TS via `console\.warn`; Python via `warnings\.warn\(category=/,
    );
    expect(p).toMatch(/DeprecationWarning\)`; Go is doc-only since runtime warnings would/);
    expect(p).toMatch(/be noisy in non-interactive callers\)/);
  });

  it('CRITICAL deprecation-removal-cycle framing pinned. Pre-1.0: at least one MINOR-or-greater containing the deprecation notice; the 30-day minimum even if version cadence is rapid.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Removal happens after \*\*at least one MINOR version release\*\* that\s*\n?contains the deprecation notice\./,
    );
    expect(p).toMatch(
      /The deprecation period is at minimum 30 days post-deprecation-release\s*\n?to give customers time to migrate even if the version cadence is\s*\n?rapid\./,
    );
  });

  it('CRITICAL deprecation timeline example pinned — v0.5.0 deprecate + ship replacement, v0.7.0 (or later) removed. The pre-1.0 + post-1.0 examples explain the asymmetric MINOR-vs-MAJOR removal cadence.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/v0\.5\.0: deprecate `oldMethod`, ship replacement `newMethod`\./);
    expect(p).toMatch(/v0\.5\.x: patches; oldMethod still works with deprecation warning\./);
    expect(p).toMatch(/v0\.6\.0: oldMethod still works with warning\./);
    expect(p).toMatch(
      /v0\.7\.0 \(or later\): oldMethod removed; major-equivalent change\s*\n?\s+\(since pre-1\.0, MINOR bump is sufficient signal\)\./,
    );
    expect(p).toMatch(/vX\.Y\.Z: deprecate\./);
    expect(p).toMatch(/vX\.\(Y\+1\)\.0: still works with warning\./);
    expect(p).toMatch(/v\(X\+1\)\.0\.0: removed\./);
  });

  it('CRITICAL 4-item migration-guide framing pinned. Old code + new code + sed/regex replacement + behavioral diffs. The migration script ships inside the SDK package as scripts/migrate-<from>-to-<to>.<ext> (2026-09-15: the page used to print the monorepo path packages/sdk-<lang>/…, which a customer cannot open — the package-relative path is what they can find).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. What the old code looked like\./);
    expect(p).toMatch(/2\. What the new code looks like\./);
    expect(p).toMatch(/3\. Sed\/regex replacement when feasible\./);
    expect(p).toMatch(/4\. Behavioral differences \(if any\) that aren't a pure rename\./);
    expect(p).toMatch(
      /For non-trivial breaks, a migration script ships inside the SDK package\s*\n?as `scripts\/migrate-<from>-to-<to>\.<ext>`\./,
    );
    expect(p).not.toMatch(/packages\/sdk-<lang>/);
    expect(p).toMatch(/a migration script ships inside the SDK package/);
  });

  it('CRITICAL 4-item cross-SDK lockstep framing pinned. Resource names + Error class hierarchy + verifyWebhookSignature helper + OpenAPI regen. The \'When a feature lands in one SDK but not another, the missing SDKs get a CHANGELOG note ("planned for v0.X.Y") and a tracking issue. The lag should be ≤ one MINOR release\' wording is the load-bearing parity contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Resource names \+ method names\. `client\.sessions\.create\(\)` exists in/);
    expect(p).toMatch(/Error class hierarchy\. `RateLimitError` \/ `InvalidKeyError` \//);

    // V-1138 negative — two problem types deliberately carry different class
    // names across the SDKs, so the unqualified lockstep claim was false. Quoted
    // here so it cannot return; the corrected bullet paraphrases it.
    expect(p, 'the unqualified same-names-in-each claim is back').not.toMatch(
      /exist with the same names in each/,
    );
    // V-1138 — this froze the unqualified claim. Two problem types deliberately carry
    // different class names across the SDKs, so the page now names them; the anchor
    // kept here is the stable half of the sentence.
    expect(p).toMatch(/`SessionTimeoutError` \/ etc\. exist in all three/);
    expect(p).toMatch(/`QuotaExceededError` in Python and Go/);
    expect(p).toMatch(/`driver-not-integrated`/);
    expect(p).toMatch(
      /Webhook signature verification helper\. `verifyWebhookSignature` in\s*\n?\s+TS, `verify_webhook_signature` in Python, `VerifyWebhookSignature`\s*\n?\s+in Go\./,
    );
    expect(p).toMatch(/OpenAPI schema\. Each SDK regenerates its types from the same/);
    expect(p).toMatch(/`openapi\.json` per release\./);
    expect(p).toMatch(
      /When a feature lands in one SDK but not another, the missing SDKs\s*\n?get a CHANGELOG parity note and a tracking issue\. The lag must not\s*\n?exceed one MINOR release\./,
    );
  });

  it('CRITICAL 3-language version-pinning recommendations pinned, and each number is DERIVED from the package it pins. TS caret (pre-1.0 minor pin) + Python PEP 440 on the REAL dist name driftstack-sdk (S36 2026-07-07 fable-truth-audit: pinning `driftstack` would target a different PyPI package) + Go go.mod + go get -u. A literal here went stale for four months while this guard stayed green — the page recommended ^0.1.5 with 0.1.6 on npm.', () => {
    const p = read(PAGE);
    const ts = typescriptSdkVersion();
    const py = pythonSdkVersion();
    const go = goSdkVersion();

    expect(p, `the TypeScript pin must name the published version ${ts}`).toContain(
      `"@driftstack/sdk": "^${ts}"\``,
    );
    expect(p, `the Python floor must name the published version ${py}`).toContain(
      `\`driftstack-sdk>=${py},<${nextMinor(py)}\``,
    );
    expect(p, `the Python compatible-release pin must name ${py}`).toContain(
      `\`driftstack-sdk~=${py}\``,
    );
    expect(p).toMatch(/PEP 440 compatible-release/);
    expect(p).toMatch(/pip install driftstack-sdk/);
    expect(p).toMatch(/`go\.mod` with `github\.com\/driftstackdev\/driftstack-api\//);
    expect(p, `the Go pin must name the version the tag will carry, v${go}`).toContain(
      `packages/sdk-go v${go}\``,
    );
    expect(p).toMatch(/Bump via `go get -u`\./);
    // Negative pin — the bare-import-name pin advice must not come back, at any version.
    expect(p).not.toMatch(/`driftstack[>~]=\d/);
  });

  it("CRITICAL the page tells a production reader what the three install lines above have in common, and it is NOT 'pin exact'. The pin MOVED on 2026-09-20: this used to require 'Production deployments SHOULD pin exact versions and bump deliberately', which contradicted the caret / compatible-release / go.mod recommendations three paragraphs above it and the SDK README as well — four published documents, four answers. The one answer: while a package is 0.x a MINOR can change the surface and a PATCH never does, so the default install already takes only the safe releases; a lockfile is what makes a build reproducible, and pinning exactly is for when you need that and nothing else", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /while a package is `0\.x`, a\s*\n?MINOR version can change the surface and a PATCH never does/,
    );
    expect(p, 'the reader is no longer told to read the CHANGELOG before a minor').toMatch(
      /Read the CHANGELOG before moving\s*\n?to a new minor\./,
    );
    expect(
      p,
      'the exact-pin escape hatch lost its condition, which is what made it advice',
    ).toMatch(/Pin an exact version only if you need a byte-for-byte\s*\n?reproducible build/);
    expect(p, 'the page must not go back to recommending an exact pin by default').not.toMatch(
      /Production deployments SHOULD pin exact versions/,
    );
  });

  it('CRITICAL Releases section pinned — every SDK release ships a CHANGELOG entry and a GitHub release post with a migration guide when breaking. The internal publish playbook (push-to-main, npm/twine/go-tag commands, release-approval gate) was removed from the customer page and must not return.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^## Releases$/m);
    expect(p).toMatch(
      /Each SDK release ships with a CHANGELOG entry and a GitHub release\s*\n?post that includes a migration guide when the release is breaking\./,
    );
    expect(p).not.toMatch(/push-to-main|npm publish|twine upload|sub-directory tagging/);
    expect(p).not.toMatch(
      /release approval|founder approval|customer base|publishes will run autonomously|Pre-launch/,
    );
  });

  it('CRITICAL cross-reference footer pinned — CHANGELOG.md only. The internal decision-log (D-021) and monorepo-path (packages/api-types Zod) pointers were removed from the customer page and must not return.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Each SDK's `CHANGELOG\.md` for the running history\./);
    expect(p).not.toMatch(/docs\/decisions\.md|D-021/);
    expect(p).not.toMatch(/`packages\/api-types\/` for the Zod schemas/);
  });

  it('CRITICAL out-of-scope 3-item set pinned — LTS branches + public deprecation timeline doc + telemetry on deprecated-call usage. Drift to claiming any of these would over-promise to customers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*LTS branches\*\*\. The SDKs don't carry long-term support/);
    expect(p).toMatch(/\*\*Deprecation notices\*\*\. The SDK CHANGELOGs and source-level/);
    expect(p).toMatch(/\*\*Telemetry on deprecated-call usage\*\*\./);
    expect(p).toMatch(/for deprecated SDK call sites is not collected\./);
    expect(p).not.toMatch(/future surface|future workstream|something we'll introduce/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-sdk-versioning-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
