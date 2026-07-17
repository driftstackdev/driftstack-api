// W814 — cross-SDK README structure parity. One-hundred-fortieth in
// the drift-guard series. Pins the 3 SDK READMEs as a lockstep group:
// required section set + install commands + status framing.
// Drift would let one SDK's README diverge in structure from its
// siblings, breaking the docs/sdk navigation that links to specific
// anchor sections across all 3.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/README.md');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/README.md');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/README.md');

describe('W814 cross-SDK README structure parity', () => {
  it('all 3 SDK READMEs exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Title shape ──────────────────────────────────────────────

  it("CRITICAL each SDK README starts with the canonical title — TS: '# @driftstack/sdk' (npm scope) + Python: '# Driftstack Python SDK' + Go: '# Driftstack Go SDK'. Drift to a different title would break docs cross-link rendering.", () => {
    expect(read(TS)).toMatch(/^# @driftstack\/sdk$/m);
    expect(read(PY)).toMatch(/^# Driftstack Python SDK$/m);
    expect(read(GO)).toMatch(/^# Driftstack Go SDK$/m);
  });

  // ─── Status: alpha / pre-1.0 framing ──────────────────────────

  it('CRITICAL each SDK README has current pre-1.0 status and reproducible-install guidance without future publication promises.', () => {
    expect(read(TS)).toMatch(/> \*\*Status:\*\* pre-1\.0\. Stable surface for the API contract/);
    expect(read(PY)).toMatch(
      /> \*\*Status:\*\* published on PyPI, pre-1\.0, and classified Alpha\. Use requirements constraints or a lockfile for reproducible deployments\./,
    );
    expect(read(GO)).toMatch(
      /> \*\*Status:\*\* published as a tagged pre-1\.0 module\. Commit `go\.mod` and `go\.sum` for reproducible deployments\./,
    );
    expect(read(PY)).not.toMatch(/source commit|PyPI tag pending/i);
    expect(read(GO)).not.toMatch(/pseudo-version|first tag pending/i);
  });

  // ─── Cross-SDK 6-section required set ─────────────────────────

  it('CRITICAL all 3 SDK READMEs include the 6 required navigation sections — Install + Quickstart + Resources + Error handling/Errors + Retry/Retry behaviour + Webhook signature verification. Drift to dropping any would break docs/sdk anchor cross-links.', () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p, `${f} must have ## Install`).toMatch(/^## Install$/m);
      // Quickstart can be plain or sync/async variants.
      expect(p, `${f} must have ## Quickstart...`).toMatch(/^## Quickstart/m);
      expect(p, `${f} must have ## Resources`).toMatch(/^## Resources$/m);
      // Error handling vs Errors.
      expect(p, `${f} must have ## Error/s heading`).toMatch(/^## (Errors|Error handling)$/m);
      // Retry vs Retry behaviour.
      expect(p, `${f} must have ## Retry heading`).toMatch(/^## Retry( behaviour)?$/m);
      expect(p, `${f} must have ## Webhook signature verification`).toMatch(
        /^## Webhook signature verification$/m,
      );
      expect(p, `${f} must have ## Examples`).toMatch(/^## Examples$/m);
    }
  });

  // ─── Install commands (each SDK's package manager) ────────────

  it('CRITICAL each SDK README has its working current registry install command.', () => {
    expect(read(TS)).toMatch(/npm install @driftstack\/sdk/);
    expect(read(TS)).toMatch(/pnpm add @driftstack\/sdk/);
    expect(read(TS)).toMatch(/yarn add @driftstack\/sdk/);
    expect(read(PY)).toMatch(/^pip install driftstack-sdk$/m);
    expect(read(GO)).toMatch(
      /^go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go@latest$/m,
    );
  });

  // ─── Python-specific dist-vs-import note ──────────────────────

  it('CRITICAL Python README pins the distribution-name-vs-import-name distinction.', () => {
    const p = read(PY);
    expect(p).toMatch(
      /The distribution name is `driftstack-sdk`; the import name is `driftstack`\./,
    );
    expect(p).toMatch(/Requires Python 3\.10\+\./);
  });

  // ─── Go-specific minimum-version note ─────────────────────────

  it("CRITICAL Go README pins the minimum-version requirement. The module's go.mod declares `go 1.22`, so the floor is Go 1.22+ (the previous 'Requires Go 1.21+' was stale — a 1.21 toolchain can't build a `go 1.22` module; the docs/quickstarts already migrated to 1.22+ on 2026-06-24). This is the load-bearing 'which Go versions work' anchor.", () => {
    const p = read(GO);
    expect(p).toMatch(
      /Requires Go 1\.22\+ \(the module's `go\.mod` declares `go 1\.22`; uses `errors\.As`, `context\.Cancel\*`, and the `slices` package\)\./,
    );
    // Drift sentinel — the stale 1.21 floor must NOT return.
    expect(p).not.toMatch(/Requires Go 1\.21\+/);
  });

  // ─── Python sync + async dual framing ─────────────────────────

  it("CRITICAL Python README documents sync + async client dual + same shared resource set. 'Sync (Driftstack) and async (AsyncDriftstack) clients in one package, sharing the same typed resources, error hierarchy, and retry policy' is the load-bearing 'both clients, same surface' anchor. Drift to forking the surfaces would break the W798 pagination cross-SDK lockstep.", () => {
    const p = read(PY);
    expect(p).toMatch(
      /Sync \(`Driftstack`\) and async \(`AsyncDriftstack`\) clients in one package, sharing the same typed resources, error hierarchy, and retry policy\./,
    );
    expect(p).toMatch(/^## Quickstart \(sync\)$/m);
    expect(p).toMatch(/^## Quickstart \(async\)$/m);
  });

  // ─── Go-specific zero-non-stdlib framing ──────────────────────

  it("CRITICAL Go README pins 'zero non-stdlib runtime dependencies' + 'context-aware throughout'. The dual claim is the load-bearing 'this SDK is friendly to dependency-paranoid Go shops' anchor matched in CHANGELOG (W813).", () => {
    const p = read(GO);
    expect(p).toMatch(/zero non-stdlib runtime dependencies, context-aware throughout/);
  });

  // ─── TS pre-1.0 + Stable-surface-for-API-contract framing ─────

  it("CRITICAL TS README pins 'Stable surface for the API contract; the SDK API may shift before 1.0. Don't pin against an exact version yet' framing. The dual SDK-vs-API stability statement is the load-bearing version-pinning guidance.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /Stable surface for the API contract; the SDK API may shift before 1\.0\. Don't pin against an exact version yet\./,
    );
  });

  // ─── Cross-SDK References + Configuration sections ────────────

  it('CRITICAL Python + Go READMEs include ## Configuration + ## Development sections. The dual Configuration + Development pair is the canonical "how do I configure + contribute" framing matched between Py + Go.', () => {
    expect(read(PY)).toMatch(/^## Configuration$/m);
    expect(read(PY)).toMatch(/^## Development$/m);
    expect(read(GO)).toMatch(/^## Configuration$/m);
    expect(read(GO)).toMatch(/^## Development$/m);
  });

  // ─── Section-order invariant ──────────────────────────────────

  it('CRITICAL section ordering is consistent across all 3 SDKs — Install → Quickstart → Resources → (Errors|Error handling) → (Retry|Retry behaviour) → Webhook signature verification → Examples. Drift to reordering would break linear-reading flow + lose section-anchor stability.', () => {
    function sectionOrder(p: string): string[] {
      return p
        .split('\n')
        .filter((l) => /^## /.test(l))
        .map((l) => l.replace(/^## /, ''));
    }

    function requireOrder(sections: string[], expected: RegExp[]): void {
      let lastIdx = -1;
      for (const e of expected) {
        const idx = sections.findIndex((s, i) => i > lastIdx && e.test(s));
        expect(
          idx,
          `expected ${e} after index ${lastIdx} in ${sections.join(' / ')}`,
        ).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    }

    for (const f of [TS, PY, GO]) {
      const sections = sectionOrder(read(f));
      requireOrder(sections, [
        /^Install$/,
        /^Quickstart/,
        /^Resources$/,
        /^(Errors|Error handling)$/,
        /^Retry( behaviour)?$/,
        /^Webhook signature verification$/,
        /^Examples$/,
      ]);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-readmes-cross-sdk-structure-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
