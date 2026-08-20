// W558.B — drift guard for /docs/architecture/sdk-versioning.md.
// V-177 SDK versioning + deprecation policy. Drift here either
// weakens the 3-SDK-lockstep posture (TS+Python+Go), drops the
// SemVer-2.0.0 + pre-1.0-no-relaxation discipline, or loosens the
// 30-day-minimum deprecation window commitment.
//
//   • V-177. Effective 2026-05-05. 3 SDKs lockstep.
//   • SemVer 2.0.0 MAJOR/MINOR/PATCH.
//   • Control plane NOT SemVer-versioned; /v1/-/v2/-URL-prefix.
//   • Pre-1.0 (0.x.y) — no relaxation, same deprecation bar as
//     post-1.0.
//   • 1.0.0 ships when first-paying-customer + 30-days-prod-use +
//     founder-explicit-approval.
//   • Deprecation: @deprecated JSDoc / DeprecationWarning / Go
//     doc-comment + CHANGELOG + runtime warning + ≥1-MINOR-cycle
//     before removal + 30-day-minimum.
//   • Cross-SDK lockstep: resource/method names + error class
//     hierarchy + webhook signature helper + OpenAPI schema.
//   • Pre-launch publish gated on founder; post-launch MAJOR
//     always founder-approved.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/sdk-versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W558.B /docs/architecture/sdk-versioning.md content parity', () => {
  const body = read(LIB);

  it("Header + V-177 + 3-SDK applies-to framing pinned: '# SDK versioning + deprecation policy' + '**Status:** Active' + '**Effective date:** 2026-05-05 (V-177)' + '**Applies to:** `@driftstack/sdk` (TypeScript), `driftstack` (Python),' + '`github.com/driftstackdev/driftstack-api/packages/sdk-go` (Go).' + 'The three SDKs follow the same versioning + deprecation policy.' + 'Each maintains its own CHANGELOG.md tracking concrete additions / removals' — pinned so the V-177-effective-2026-05-05 + 3-SDK-applies-to (TS-@driftstack/sdk + Python-driftstack + Go-packages/sdk-go) + per-SDK-CHANGELOG.md commitment survives", () => {
    expect(body).toMatch(/^# SDK versioning \+ deprecation policy$/m);
    expect(body).toMatch(/\*\*Status:\*\* Active/);
    expect(body).toMatch(/\*\*Effective date:\*\* 2026-05-05 \(V-177\)/);
    // V-1105 — the applies-to line named `driftstack` as the Python package.
    // That is the import name; the distribution is `driftstack-sdk`, and this
    // file's pinning section gave a `driftstack>=…` requirement line that does
    // not resolve. Both now say the distribution and note the import name.
    expect(body).toMatch(
      /\*\*Applies to:\*\* `@driftstack\/sdk` \(TypeScript\), `driftstack-sdk`\s*\n?\s*\(Python — the PyPI distribution; the import name is `driftstack`\),/,
    );
    expect(body).toMatch(/`github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go` \(Go\)\./);
    expect(body).toMatch(/The three SDKs follow the same versioning \+ deprecation policy\./);
    expect(body).toMatch(
      /Each\s*\n?\s*maintains its own CHANGELOG\.md tracking concrete additions \/ removals/,
    );
  });

  it("SemVer 2.0.0 + control-plane-not-SemVer framing pinned: '## Versioning — SemVer' + 'All three SDKs follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html):' + '**MAJOR** bump on breaking changes — any change that requires' + 'customer code to be modified to keep working.' + '**MINOR** bump on backwards-compatible feature additions.' + '**PATCH** bump on backwards-compatible bug fixes.' + 'The control plane (`apps/server`) is NOT versioned — its API is' + 'versioned via the `/v1/` URL prefix; breaking changes there bump to' + '`/v2/`. SDKs follow whichever API version they target.' — pinned so the SemVer-2.0.0 + MAJOR/MINOR/PATCH-definition + control-plane-NOT-SemVer + /v1-/v2-URL-prefix-version commitment survives", () => {
    expect(body).toMatch(/## Versioning — SemVer/);
    expect(body).toMatch(
      /All three SDKs follow \[SemVer 2\.0\.0\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\):/,
    );
    expect(body).toMatch(/- \*\*MAJOR\*\* bump on breaking changes — any change that requires/);
    expect(body).toMatch(/customer code to be modified to keep working\./);
    expect(body).toMatch(/- \*\*MINOR\*\* bump on backwards-compatible feature additions\./);
    expect(body).toMatch(/- \*\*PATCH\*\* bump on backwards-compatible bug fixes\./);
    expect(body).toMatch(/The control plane \(`apps\/server`\) is NOT versioned — its API is/);
    expect(body).toMatch(/versioned via the `\/v1\/` URL prefix; breaking changes there bump to/);
    expect(body).toMatch(/`\/v2\/`\. SDKs follow whichever API version they target\./);
  });

  it("Pre-1.0 + 1.0.0-3-condition framing pinned: '## Pre-1.0 stability' + 'All three SDKs are currently pre-1.0 (`0.x.y`).' + 'Pre-1.0 SemVer relaxes the breaking-change rule for MINOR bumps' + 'We DO NOT take advantage of this — pre-1.0 breaks bump the MINOR version' + 'The bar is the same as post-1.0;' + '`1.0.0` ships when:' + 'Driftstack has its first paying customer.' + 'The SDK has been in production use at that customer for ≥ 30 days' + 'Founder explicitly approves the 1.0 cut.' — pinned so the pre-1.0-no-relaxation + same-bar-as-post-1.0 + 3-1.0-ship-condition (paying-customer + 30-days-prod + founder-approve) commitment survives", () => {
    expect(body).toMatch(/## Pre-1\.0 stability/);
    expect(body).toMatch(/All three SDKs are currently pre-1\.0 \(`0\.x\.y`\)\./);
    expect(body).toMatch(
      /Pre-1\.0 SemVer\s*\n?\s*relaxes the breaking-change rule for MINOR bumps/,
    );
    expect(body).toMatch(/We DO NOT take advantage of this — pre-1\.0/);
    expect(body).toMatch(/breaks bump the MINOR version/);
    expect(body).toMatch(/The bar is the same as post-1\.0;/);
    expect(body).toMatch(/`1\.0\.0` ships when:/);
    expect(body).toMatch(/1\. Driftstack has its first paying customer\./);
    expect(body).toMatch(/2\. The SDK has been in production use at that customer for ≥ 30 days/);
    expect(body).toMatch(/3\. Founder explicitly approves the 1\.0 cut\./);
  });

  it("Deprecation policy + 3-emit-mechanism + 30-day-minimum framing pinned: '## Deprecation policy' + 'A method, type, or behavior is deprecated by:' + 'Adding `@deprecated` JSDoc / Python `DeprecationWarning` / Go' + 'doc-comment `// Deprecated:`' + 'CHANGELOG.md entry under the next MINOR-or-greater release' + 'SDK runtime emits a one-time deprecation warning on first use' + 'TS via `console.warn`; Python via `warnings.warn' + 'Go is doc-only since runtime warnings would' + 'be noisy in non-interactive callers' + 'Removal happens after **at least one MINOR version release**' + 'v0.5.0: deprecate `oldMethod`, ship replacement `newMethod`.' + 'v0.7.0 (or later): oldMethod removed' + 'The deprecation period is at minimum 30 days post-deprecation-release' — pinned so the 3-emit-mechanism (@deprecated-JSDoc + DeprecationWarning + // Deprecated:-doc) + Go-doc-only-non-interactive + ≥1-MINOR-cycle + 30-day-minimum commitment survives", () => {
    expect(body).toMatch(/## Deprecation policy/);
    expect(body).toMatch(/A method, type, or behavior is deprecated by:/);
    expect(body).toMatch(/1\. Adding `@deprecated` JSDoc \/ Python `DeprecationWarning` \/ Go/);
    expect(body).toMatch(/doc-comment `\/\/ Deprecated:`/);
    expect(body).toMatch(/2\. CHANGELOG\.md entry under the next MINOR-or-greater release/);
    expect(body).toMatch(/3\. SDK runtime emits a one-time deprecation warning on first use/);
    expect(body).toMatch(/TS via `console\.warn`; Python via `warnings\.warn/);
    expect(body).toMatch(/Go is doc-only since runtime warnings would/);
    expect(body).toMatch(/be noisy in non-interactive callers/);
    expect(body).toMatch(/Removal happens after \*\*at least one MINOR version release\*\*/);
    expect(body).toMatch(/- v0\.5\.0: deprecate `oldMethod`, ship replacement `newMethod`\./);
    expect(body).toMatch(/- v0\.7\.0 \(or later\): oldMethod removed/);
    expect(body).toMatch(/The deprecation period is at minimum 30 days post-deprecation-release/);
  });

  it("Cross-SDK lockstep + pinning + release-process framing pinned: '## Cross-SDK consistency' + 'The three SDKs MUST stay in lockstep on:' + 'Resource names + method names. `client.sessions.create()` exists in' + 'Error class hierarchy. `RateLimitError` / `InvalidKeyError` /' + '`SessionTimeoutError` / etc.' + 'Webhook signature verification helper. `verifyWebhookSignature` in' + 'TS, `verify_webhook_signature` in Python, `VerifyWebhookSignature`' + 'in Go.' + 'OpenAPI schema. Each SDK regenerates its types from the same' + 'The lag should be ≤ one MINOR release.' + '## Version-pinning recommendations' + '**TypeScript**: `\"@driftstack/sdk\": \"^0.1.5\"`' + '**Python**: `driftstack>=0.1.5,<0.2` or' + '**Go**: `go.mod`' + '## Release process' + 'TS: `npm publish` from `packages/sdk-typescript/`.' + 'Python: `python -m build && python -m twine upload`' + 'Go: tag the commit with `packages/sdk-go/v<version>`' + 'Pre-launch (no paying customers yet) the publish steps are gated on' + 'founder approval. Post-launch, MINOR + PATCH publishes are' + 'autonomous; MAJOR publishes always require explicit founder approval.' — pinned so the cross-SDK-lockstep-4-category + 3-pin-recommendation + 3-language-publish + pre-launch-gated + MAJOR-always-founder commitment survives", () => {
    expect(body).toMatch(/## Cross-SDK consistency/);
    expect(body).toMatch(/The three SDKs MUST stay in lockstep on:/);
    expect(body).toMatch(
      /- Resource names \+ method names\. `client\.sessions\.create\(\)` exists in/,
    );
    expect(body).toMatch(/- Error class hierarchy\. `RateLimitError` \/ `InvalidKeyError` \//);
    expect(body).toMatch(/`SessionTimeoutError` \/ etc\./);
    expect(body).toMatch(/- Webhook signature verification helper\. `verifyWebhookSignature` in/);
    expect(body).toMatch(/TS, `verify_webhook_signature` in Python, `VerifyWebhookSignature`/);
    expect(body).toMatch(/in Go\./);
    expect(body).toMatch(/- OpenAPI schema\. Each SDK regenerates its types from the same/);
    expect(body).toMatch(/The lag should be ≤ one MINOR release\./);
    expect(body).toMatch(/## Version-pinning recommendations/);
    expect(body).toMatch(/- \*\*TypeScript\*\*: `"@driftstack\/sdk": "\^0\.1\.5"`/);
    // V-1105 — this required `driftstack>=0.1.5,<0.2`, a pin that does not
    // resolve to this SDK: the PyPI distribution is `driftstack-sdk` and
    // `driftstack` is only the import name. The customer page carries a
    // NEGATIVE sentinel against that exact string
    // (docs-pages-sdk-versioning-content-parity), so the repo was banning it in
    // one file and mandating it in another, with both guards green. The
    // distribution name is read from pyproject.toml now rather than spelled
    // here, so the two cannot disagree again.
    const dist = /^name = "([^"]+)"/m.exec(
      readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml'), 'utf8'),
    );
    expect(
      dist,
      'the Python distribution name is no longer declared in pyproject.toml',
    ).not.toBeNull();
    const distName = dist?.[1] ?? '';
    expect(distName, 'the distribution name parsed as empty').toMatch(/\S/);
    expect(body, `the Python pin must name the ${distName} distribution`).toContain(
      `- **Python**: \`${distName}>=0.1.5,<0.2\` or`,
    );
    expect(body, 'the bare import-name pin must not return').not.toMatch(
      /`driftstack>=0\.1\.5|`driftstack~=0\.1\.5`/,
    );
    expect(body).toMatch(/- \*\*Go\*\*: `go\.mod`/);
    expect(body).toMatch(/## Release process/);
    expect(body).toMatch(/- TS: `npm publish` from `packages\/sdk-typescript\/`\./);
    expect(body).toMatch(/- Python: `python -m build && python -m twine upload`/);
    expect(body).toMatch(/- Go: tag the commit with `packages\/sdk-go\/v<version>`/);
    expect(body).toMatch(/Pre-launch \(no paying customers yet\) the publish steps are gated on/);
    expect(body).toMatch(/founder approval\. Post-launch, MINOR \+ PATCH publishes are/);
    expect(body).toMatch(/autonomous; MAJOR publishes always require explicit founder approval\./);
  });

  it("Migration paths + cross-references + out-of-scope-3 framing pinned: '## Migration paths' + 'a **migration guide** in the GitHub release notes covering:' + 'What the old code looked like.' + 'What the new code looks like.' + 'Sed/regex replacement when feasible.' + 'Behavioral differences (if any) that aren't a pure rename.' + 'a migration script ships in' + '`packages/sdk-<lang>/scripts/migrate-<from>-to-<to>.<ext>`' + '## Cross-references' + '`docs/decisions.md` D-021 for the original SDK package decision' + '(TypeScript-first, expanded to Python + Go in V-035 + V-038).' + '`packages/api-types/` for the Zod schemas that drive' + '## Out of scope (today)' + '**LTS branches**.' + '**Public deprecation timeline doc**.' + '`docs.driftstack.dev/sdk/deprecations`' + '**Telemetry on deprecated-call usage**' — pinned so the 4-migration-guide-component + migration-script-naming + D-021-V-035-V-038 + 3-out-of-scope (LTS + public-deprecation-doc + telemetry) commitment survives", () => {
    expect(body).toMatch(/## Migration paths/);
    expect(body).toMatch(/the SDK release post includes a/);
    expect(body).toMatch(/\*\*migration guide\*\* in the GitHub release notes covering:/);
    expect(body).toMatch(/1\. What the old code looked like\./);
    expect(body).toMatch(/2\. What the new code looks like\./);
    expect(body).toMatch(/3\. Sed\/regex replacement when feasible\./);
    expect(body).toMatch(/4\. Behavioral differences \(if any\) that aren't a pure rename\./);
    expect(body).toMatch(/a migration script ships in/);
    expect(body).toMatch(/`packages\/sdk-<lang>\/scripts\/migrate-<from>-to-<to>\.<ext>`/);
    expect(body).toMatch(/## Cross-references/);
    expect(body).toMatch(/- `docs\/decisions\.md` D-021 for the original SDK package decision/);
    expect(body).toMatch(/\(TypeScript-first, expanded to Python \+ Go in V-035 \+ V-038\)\./);
    expect(body).toMatch(/- `packages\/api-types\/` for the Zod schemas that drive/);
    expect(body).toMatch(/## Out of scope \(today\)/);
    expect(body).toMatch(/- \*\*LTS branches\*\*\./);
    expect(body).toMatch(/- \*\*Public deprecation timeline doc\*\*\./);
    expect(body).toMatch(/`docs\.driftstack\.dev\/sdk\/deprecations`/);
    expect(body).toMatch(/- \*\*Telemetry on deprecated-call usage\*\*/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
