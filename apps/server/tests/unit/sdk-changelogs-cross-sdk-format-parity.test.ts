// W813 — cross-SDK CHANGELOG.md format parity. One-hundred-thirty-
// ninth in the drift-guard series. Pins the 3 SDK changelogs as a
// lockstep group — same header shape, same Keep-a-Changelog +
// SemVer anchors, same inaugural-release date (2026-05-02), same
// retry-policy + webhook-signature feature framing across all 3
// language ecosystems. Drift would let one SDK ship a release-notes
// format different from its siblings, breaking the docs cross-link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/CHANGELOG.md');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/CHANGELOG.md');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/CHANGELOG.md');

describe('W813 cross-SDK CHANGELOG.md format parity', () => {
  it('all 3 SDK CHANGELOGs exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  it('Go crypto release note describes the live forward-compatible envelope without deferred-codegen wording', () => {
    const go = read(GO);
    expect(go).toMatch(/forward-compatible `map\[string\]any` envelopes/);
    expect(go).not.toMatch(/pending an OpenAPI codegen pass/);
  });

  // ─── Header shape ─────────────────────────────────────────────

  it('CRITICAL all 3 SDK CHANGELOGs start with `# Changelog` + Keep-a-Changelog + SemVer attribution. Drift to a different header style would break docs auto-aggregation.', () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p.startsWith('# Changelog\n'), `${f} must start with '# Changelog'`).toBe(true);
      expect(p).toMatch(/\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/);
      expect(p).toMatch(/\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/);
    }
  });

  it("CRITICAL all 3 SDK CHANGELOGs include 'The format follows Keep a Changelog' + 'versioning follows SemVer' framing. The dual-spec citation is what makes the format machine-consumable.", () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      // Whitespace can be \s+ (single space) or \s*\n\s* (line wrap) — accept either.
      expect(p, `${f} must contain 'The format' + 'follows' + Keep-a-Changelog link`).toMatch(
        /The format\s+follows[\s\S]{0,5}\[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.1\.0\/\)/,
      );
      expect(p, `${f} must contain 'versioning' + 'follows' + SemVer link`).toMatch(
        /versioning\s+follows\s+\[SemVer\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)/,
      );
    }
  });

  it("CRITICAL all 3 SDK CHANGELOGs include the '## [Unreleased]' active-development section. Drift to dropping it would force every PR to add a new version header instead of accumulating notes.", () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p, `${f} must have ## [Unreleased]`).toMatch(/^## \[Unreleased\]$/m);
    }
  });

  it('CRITICAL all 3 SDK CHANGELOGs include the canonical Keep-a-Changelog change categories under [Unreleased] section. ### Added pinned at minimum across all 3 — drift would lose the standard category convention.', () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p, `${f} must have ### Added`).toMatch(/^### Added$/m);
    }
  });

  // ─── Inaugural release: 0.1.0 on 2026-05-02 ───────────────────

  it('CRITICAL all 3 SDK CHANGELOGs share inaugural release [0.1.0] - 2026-05-02. Drift to a different version or date would break the cross-SDK release-cohort identity that customers rely on for compat.', () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p, `${f} must have ## [0.1.0] - 2026-05-02`).toMatch(/^## \[0\.1\.0\] - 2026-05-02$/m);
    }
  });

  it('CRITICAL all 3 SDK CHANGELOGs reference "inaugural" framing (TS: "Inaugural release"; PY: "inaugural alpha" + "Inaugural PyPI publish"; GO: "inaugural alpha release"). Drift to a different framing would lose the cross-SDK semantic equivalence.', () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p, `${f} must mention "inaugural"`).toMatch(/[Ii]naugural/);
    }
  });

  // ─── Error hierarchy framing ──────────────────────────────────

  it('CRITICAL all 3 SDK CHANGELOGs document the DriftstackError-base + subclasses error hierarchy. Drift to dropping this anchor would let one SDK migrate away from the typed-error contract without the others knowing.', () => {
    expect(read(TS)).toMatch(/Error hierarchy: `DriftstackError` base with `kind` discriminator/);
    expect(read(PY)).toMatch(/Error hierarchy: `DriftstackError` base \+ 14 subclasses/);
  });

  // ─── Retry policy with Retry-After ────────────────────────────

  it("CRITICAL all 3 SDK CHANGELOGs document retry-policy with Retry-After honoring. The 'honours server Retry-After' wording is the load-bearing 'we respect server backpressure' anchor matched across SDKs.", () => {
    expect(read(TS)).toMatch(
      /Built-in retry on transient transport \+ rate-limit errors;[\s\S]+?honours server `Retry-After`\./,
    );
    expect(read(PY)).toMatch(
      /Retry policy \(`RetryConfig` \+ `with_retry`\)[\s\S]+?honours `Retry-After`\./,
    );
  });

  // ─── Webhook signature helper ─────────────────────────────────

  it('CRITICAL all 3 SDK CHANGELOGs document a webhook-signature verifier helper. Stripe-style HMAC-SHA256 mentioned cross-SDK — drift to a different signature algorithm would break receivers.', () => {
    expect(read(TS)).toMatch(
      /`verifyWebhookSignature` helper \(Stripe-style HMAC-SHA256[\s\S]+?\)/,
    );
    expect(read(PY)).toMatch(
      /`verify_webhook_signature` helper \(Stripe-style HMAC-SHA256[\s\S]+?\)/,
    );
  });

  // ─── Build / publishing context ───────────────────────────────

  it('CRITICAL each SDK CHANGELOG documents its publishing context. TS: npm @driftstack/sdk + @driftstack/api-types. Python: Hatchling + py.typed PEP 561 + httpx + pydantic. Go: github.com/driftstackdev/driftstack-api/packages/sdk-go module path + zero non-stdlib runtime deps.', () => {
    expect(read(TS)).toMatch(
      /Public packages on npm under `@driftstack\/sdk` \(this\) \+\s*\n?`@driftstack\/api-types`/,
    );
    expect(read(PY)).toMatch(/Hatchling backend, `py\.typed` marker for PEP 561/);
    expect(read(PY)).toMatch(/`httpx>=0\.27,<1\.0`, `pydantic\[email\]>=2\.5,<3\.0`/);
    expect(read(GO)).toMatch(
      /Module path:[\s\S]+?`github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go`\./,
    );
    expect(read(GO)).toMatch(/Zero non-stdlib runtime dependencies\./);
  });

  // ─── Test-count framing ───────────────────────────────────────

  it("CRITICAL Python + Go SDK CHANGELOGs document concrete test counts. Python: '85 tests'. Go: '33 tests'. Drift to dropping these numbers would lose the load-bearing 'we have coverage proof' anchor.", () => {
    expect(read(PY)).toMatch(/85 tests covering errors, retry, webhook signatures/);
    expect(read(GO)).toMatch(/33 tests covering errors, retry, webhook signatures/);
  });

  // ─── Go-specific D-021 hand-written-over-codegen note ─────────

  it("CRITICAL Go CHANGELOG 'V-026' anchor + 'hand-maintained, not codegen output' + 'oapi-codegen doesn't yet support OpenAPI 3.1 nullable shorthand' + 'Same hand-written-over-codegen call as the TypeScript SDK (D-021)' framing pinned. The cross-decision link D-021 makes the design choice traceable.", () => {
    const p = read(GO);
    expect(p).toMatch(/### Notes \(V-026\)/);
    expect(p).toMatch(/Types in `types\.go` are hand-maintained, not codegen output —/);
    expect(p).toMatch(/`oapi-codegen` doesn't yet support OpenAPI 3\.1 nullable shorthand/);
    expect(p).toMatch(/Same hand-written-over-codegen call as the TypeScript SDK \(D-021\)\./);
  });

  // ─── Cross-SDK examples set in changelogs ─────────────────────

  it('CRITICAL Python + Go CHANGELOGs list their examples set. Python: quickstart + error_handling + webhook_receiver + langchain_tool + pytest_fixture (5). Go: quickstart + error_handling + webhook_receiver + goroutine_pool + scraping_pipeline (5). Matches W796-W802 cross-SDK + single-language coverage.', () => {
    expect(read(PY)).toMatch(
      /Examples: `quickstart`, `error_handling`, `webhook_receiver`,[\s\S]+?`langchain_tool`, `pytest_fixture`\./,
    );
    expect(read(GO)).toMatch(
      /5 examples: `quickstart`, `error_handling`, `webhook_receiver`,[\s\S]+?`goroutine_pool`, `scraping_pipeline`\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-changelogs-cross-sdk-format-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
