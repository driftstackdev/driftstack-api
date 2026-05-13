// W547.C — drift guard for /docs/contract-audit-2026-05-03.md.
// Public-surface contract audit triggered by V-032 drift. Drift
// here either drops the V-032/V-036 re-cut history (would lose
// the cautionary tale), removes the Go-SDK silent-noop catch
// (would conflate that critical-pre-1.0 fix with normal drift),
// or weakens the marshalling round-trip 3-SDK test coverage
// inventory.
//
//   • V-032 trigger + V-036 re-cut history.
//   • CRITICAL findings: Go SDK time_ms → time; Go SDK
//     NavigateRequest timeout_ms missing; TS+Python missing
//     wire-shape tests.
//   • Fixes landed: 3-SDK wire-shape tests (TS 13-test + Python
//     10-test + Go types_test.go extended).
//   • Go SDK 0.1.3 republished (pre-1.0, zero customers — breaking
//     fine).
//   • MEDIUM findings: tap.offset borderline mechanic; TS SDK no
//     CHANGELOG.
//   • LOW: ListDlqQuerySchema.limit + drizzle-kit-0.30.6 blocks
//     auto-gen.
//   • L-001 enforcement walk: 8 schemas verified.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/contract-audit-2026-05-03.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W547.C /docs/contract-audit-2026-05-03.md content parity', () => {
  const body = read(LIB);

  it("Header + V-032-trigger + 3-SDK-audit-scope framing pinned: '# Public-surface contract audit — 2026-05-03' + 'Triggered by V-032 drift (coordinate primitives in `InteractActionSchema`).' + 'Founder direction: read every public schema + every customer-facing SDK method across TS / Python / Go before paying customers exist; flag intent-vs-mechanic violations, required-vs-optional correctness, deprecation paths, version-bump rule clarity, marshalling round-trip test coverage.' + 'Audit method: full read of `packages/api-types/src/*.ts`, the three language SDKs' public surfaces, and their existing test coverage.' — pinned so the V-032-trigger + 3-SDK-audit (TS+Python+Go) + 5-axis-review (intent-vs-mechanic + required-vs-optional + deprecation + version-bump + marshalling) + before-paying-customers commitment survives", () => {
    expect(body).toMatch(/^# Public-surface contract audit — 2026-05-03$/m);
    expect(body).toMatch(
      /Triggered by V-032 drift \(coordinate primitives in `InteractActionSchema`\)\./,
    );
    expect(body).toMatch(/Founder direction: read every public schema \+ every customer-facing/);
    expect(body).toMatch(/SDK method across TS \/ Python \/ Go before paying customers exist;/);
    expect(body).toMatch(/flag intent-vs-mechanic violations, required-vs-optional correctness,/);
    expect(body).toMatch(/deprecation paths, version-bump rule clarity, marshalling round-trip/);
    expect(body).toMatch(/test coverage\./);
    expect(body).toMatch(
      /Audit method: full read of `packages\/api-types\/src\/\*\.ts`, the three/,
    );
    expect(body).toMatch(/language SDKs' public surfaces, and their existing test coverage\./);
  });

  it("Go SDK silent-noop: time_ms vs time + NavigateRequest timeout_ms framing pinned: '### CRITICAL — fixed in this pass' + '**Go SDK `WaitCondition.Kind` shipped as `\"time_ms\"`** but the Zod schema (and TS / Python SDKs) use `\"time\"`.' + 'Every Go customer call to `client.Wait(NewTimeCondition(...))` would have been silently rejected by the server's discriminated-union parser with a 400.' + '**Fix landed:** `packages/sdk-go/types.go:261` → `Kind: \"time\"`.' + '**Go SDK `NavigateRequest` was missing `timeout_ms`.**' + 'TS / Python SDKs both expose it; Go customers had no way to set it.' + '**Fix landed:** `packages/sdk-go/types.go:178` → added `TimeoutMS int' + 'Both fixes ride out as `Go SDK 0.1.3` (tag `packages/sdk-go/v0.1.3`).' + 'Same shape as V-032's silent-noop scroll fix — pre-1.0, zero customers, breaking is fine.' — pinned so the Go-SDK time_ms-vs-time silent-noop + types.go:261 fix + NavigateRequest-timeout_ms-missing + types.go:178 fix + Go-SDK-0.1.3-republish + pre-1.0-zero-customers-breaking-fine commitment survives", () => {
    expect(body).toMatch(/### CRITICAL — fixed in this pass/);
    expect(body).toMatch(/\*\*Go SDK `WaitCondition\.Kind` shipped as `"time_ms"`\*\*/);
    expect(body).toMatch(/Zod schema \(and TS \/ Python SDKs\) use `"time"`/);
    expect(body).toMatch(/Every Go customer/);
    expect(body).toMatch(/call to `client\.Wait\(NewTimeCondition\(\.\.\.\)\)` would have been/);
    expect(body).toMatch(/silently rejected by the server's discriminated-union parser/);
    expect(body).toMatch(/with a 400\./);
    expect(body).toMatch(/\*\*Fix landed:\*\* `packages\/sdk-go\/types\.go:261` →/);
    expect(body).toMatch(/`Kind: "time"`\./);
    expect(body).toMatch(/\*\*Go SDK `NavigateRequest` was missing `timeout_ms`\.\*\*/);
    expect(body).toMatch(/TS \/ Python SDKs both/);
    expect(body).toMatch(/expose it; Go customers had no way to set it\./);
    expect(body).toMatch(/`packages\/sdk-go\/types\.go:178` → added `TimeoutMS int/);
    expect(body).toMatch(
      /Both fixes ride out as `Go SDK 0\.1\.3` \(tag `packages\/sdk-go\/v0\.1\.3`\)\./,
    );
    expect(body).toMatch(/Same shape as V-032's silent-noop scroll fix — pre-1\.0, zero/);
    expect(body).toMatch(/customers, breaking is fine\./);
  });

  it("3-SDK marshalling round-trip test coverage framing pinned: '### CRITICAL — test-coverage gap (closed in this pass)' + '**TS and Python SDKs had no marshalling round-trip tests.**' + 'Go shipped `types_test.go` in V-032; TS and Python had no equivalent.' + 'Both bugs above would have been caught instantly by a wire-shape test that asserted `kind: \"time\"` (not `\"time_ms\"`) and that `NavigateRequest` round-trips with `timeout_ms`.' + '**Fix landed:**' + '`packages/sdk-typescript/tests/unit/wire-shape.test.ts` (13 tests covering InteractAction × 5 variants, WaitCondition × 4 variants, NavigateRequest, plus L-001 rejection assertions for `tap_at` / `type_focused`).' + '`packages/sdk-python/tests/test_wire_shape.py` (10 tests, same coverage).' + '`packages/sdk-go/types_test.go` extended with `WaitCondition` constructor tests and a `NavigateRequest` round-trip test.' + '**All three SDKs now lock in the canonical wire shape against regression.** A typo in any future schema change fails fast in the SDK's own test suite, not silently in the customer's production traffic.' — pinned so the 3-SDK wire-shape-test-landed + 13-TS + 10-Python + Go-extended + L-001 reject (tap_at + type_focused) + 5-InteractAction + 4-WaitCondition + canonical-wire-shape-lock commitment survives", () => {
    expect(body).toMatch(/### CRITICAL — test-coverage gap \(closed in this pass\)/);
    expect(body).toMatch(/\*\*TS and Python SDKs had no marshalling round-trip tests\.\*\*/);
    expect(body).toMatch(/Go/);
    expect(body).toMatch(/shipped `types_test\.go` in V-032; TS and Python had no equivalent\./);
    expect(body).toMatch(/Both bugs above would have been caught instantly by a wire-shape/);
    expect(body).toMatch(/test that asserted `kind: "time"` \(not `"time_ms"`\) and that/);
    expect(body).toMatch(/`NavigateRequest` round-trips with `timeout_ms`\./);
    expect(body).toMatch(/- `packages\/sdk-typescript\/tests\/unit\/wire-shape\.test\.ts` \(13/);
    expect(body).toMatch(/tests covering InteractAction × 5 variants, WaitCondition × 4/);
    expect(body).toMatch(/variants, NavigateRequest, plus L-001 rejection assertions for/);
    expect(body).toMatch(/`tap_at` \/ `type_focused`\)/);
    expect(body).toMatch(/- `packages\/sdk-python\/tests\/test_wire_shape\.py` \(10 tests,/);
    expect(body).toMatch(/same coverage\)\./);
    expect(body).toMatch(/- `packages\/sdk-go\/types_test\.go` extended with `WaitCondition`/);
    expect(body).toMatch(/constructor tests and a `NavigateRequest` round-trip test\./);
    expect(body).toMatch(/\*\*All three SDKs now lock in the canonical wire shape against/);
    expect(body).toMatch(/regression\.\*\*/);
  });

  it("MEDIUM tap.offset borderline + TS-SDK-no-CHANGELOG framing pinned: '### MEDIUM — surface to founder' + '**`InteractAction.tap.offset` is a borderline mechanic.** The `offset: { x, y }` field on the tap variant (`packages/api-types/src/sessions.ts:88-89`) lets the customer shift the tap by N pixels relative to the element's center.' + 'It's intent-adjacent (\"I want to tap the lower-right of this element\") but also coordinate-adjacent (\"click at this exact pixel\"). At high `offset` values it functionally becomes `tap_at` with extra steps.' + '**Keep** — document `offset` as bounded (e.g. cap at ±50px, reject larger offsets at validation).' + '**Remove** — fold positional intent into selectors instead (`button.primary > .icon-arrow`). Tighter L-001 alignment.' + 'No fix today; flagged for founder decision.' + '**TypeScript SDK has no CHANGELOG / version-bump documentation.**' + 'Python and Go both have `CHANGELOG.md` files declaring \"Keep a Changelog + SemVer\". TS SDK has neither.' — pinned so the tap.offset-borderline + sessions.ts:88-89 anchor + Keep-with-±50px-cap vs Remove-fold-into-selectors + founder-decision-pending + TS-SDK-no-CHANGELOG commitment survives", () => {
    expect(body).toMatch(/### MEDIUM — surface to founder/);
    expect(body).toMatch(/\*\*`InteractAction\.tap\.offset` is a borderline mechanic\.\*\*/);
    expect(body).toMatch(/The/);
    expect(body).toMatch(/`offset: \{ x, y \}` field on the tap variant/);
    expect(body).toMatch(/\(`packages\/api-types\/src\/sessions\.ts:88-89`\) lets the customer/);
    expect(body).toMatch(/shift the tap by N pixels relative to the element's center\./);
    expect(body).toMatch(/\*\*Keep\*\* — document `offset` as bounded \(e\.g\. cap at ±50px,/);
    expect(body).toMatch(/reject larger offsets at validation\)/);
    expect(body).toMatch(/\*\*Remove\*\* — fold positional intent into selectors instead/);
    expect(body).toMatch(/\(`button\.primary > \.icon-arrow`\)\. Tighter L-001 alignment\./);
    expect(body).toMatch(/No fix today; flagged for founder decision\./);
    expect(body).toMatch(/\*\*TypeScript SDK has no CHANGELOG \/ version-bump documentation\.\*\*/);
    expect(body).toMatch(/Python and Go both have `CHANGELOG\.md` files declaring/);
    expect(body).toMatch(/"Keep a Changelog \+ SemVer"\. TS SDK has neither\./);
  });

  it("L-001 8-schema enforcement walk + 3-SDK-final-state framing pinned: '## L-001 enforcement check' + 'Walk through every `*Schema` in `packages/api-types/src/`:' + '`accounts.ts` — Account, AccountTier, AccountStatus. Pure metadata; no mechanics. ✓' + '`admin.ts` — admin endpoints. Internal; gated behind admin scope. ✓' + '`api-keys.ts` — ApiKey, CreateApiKeyRequest. Scopes are now `read | write | admin | gui_control` — see V-036 follow-up note about gating gui_control on enterprise tier. ✓' + '`common.ts` — IDs, Iso8601, ApiKeyScope, AccountTier. ✓' + '`problem.ts` — RFC 7807 error shapes. ✓' + '`sessions.ts` — InteractAction (intent-only ✓ post-V-036), NavigateRequest, WaitCondition, CaptureRequest' + '`usage.ts` — period summaries, usage counters. ✓' + '`webhooks.ts` — webhook endpoints, deliveries, signatures. ✓' + 'No mechanic-level primitives on the customer-facing surface.' + '## Marshalling round-trip test coverage — final state' + 'TS | `tests/unit/wire-shape.test.ts` | InteractAction × 5, WaitCondition × 4, NavigateRequest, L-001 reject × 2 | ✅ landed today' + 'Python | `tests/test_wire_shape.py` | InteractAction × 5, WaitCondition × 3, NavigateRequest + bounds, L-001 reject × 2 | ✅ landed today' + 'Go | `types_test.go` | InteractAction × 4, WaitCondition × 4, NavigateRequest | ✅ extended today' — pinned so the L-001-8-schema-walk + 4-api-key-scope (read+write+admin+gui_control) + RFC-7807 + 3-SDK-final-test-state commitment survives", () => {
    expect(body).toMatch(/## L-001 enforcement check/);
    expect(body).toMatch(/Walk through every `\*Schema` in `packages\/api-types\/src\/`:/);
    expect(body).toMatch(/- `accounts\.ts` — Account, AccountTier, AccountStatus\. Pure/);
    expect(body).toMatch(/metadata; no mechanics\. ✓/);
    expect(body).toMatch(
      /- `admin\.ts` — admin endpoints\. Internal; gated behind admin scope\. ✓/,
    );
    expect(body).toMatch(/- `api-keys\.ts` — ApiKey, CreateApiKeyRequest\. Scopes are now/);
    expect(body).toMatch(/`read \| write \| admin \| gui_control` — see V-036 follow-up note/);
    expect(body).toMatch(/about gating gui_control on enterprise tier\. ✓/);
    expect(body).toMatch(/- `common\.ts` — IDs, Iso8601, ApiKeyScope, AccountTier\. ✓/);
    expect(body).toMatch(/- `problem\.ts` — RFC 7807 error shapes\. ✓/);
    expect(body).toMatch(/- `sessions\.ts` — InteractAction \(intent-only ✓ post-V-036\),/);
    expect(body).toMatch(/- `usage\.ts` — period summaries, usage counters\. ✓/);
    expect(body).toMatch(/- `webhooks\.ts` — webhook endpoints, deliveries, signatures\. ✓/);
    expect(body).toMatch(/No mechanic-level primitives on the customer-facing surface\./);
    expect(body).toMatch(/## Marshalling round-trip test coverage — final state/);
    expect(body).toMatch(/TS\s+\|\s+`tests\/unit\/wire-shape\.test\.ts`/);
    expect(body).toMatch(/Python\s+\|\s+`tests\/test_wire_shape\.py`/);
    expect(body).toMatch(/Go\s+\|\s+`types_test\.go`/);
    expect(body).toMatch(/✅ landed today/);
    expect(body).toMatch(/✅ extended today/);
  });

  it("Status close + KvK-next framing pinned: '## Status' + 'Contract audit done. All public surfaces match the L-001 lock and the canonical wire shape. The class of bug that produced V-032's scroll silent-noop and the Go `time_ms` silent-noop is now caught locally in all three SDKs by wire-shape tests.' + 'Next: entity-org transition prep (KvK 2026-05-21).' — pinned so the contract-audit-done + L-001-lock + canonical-wire-shape + V-032/time_ms class-of-bug caught + KvK-2026-05-21 transition-prep-next commitment survives", () => {
    expect(body).toMatch(/## Status/);
    expect(body).toMatch(/Contract audit done\. All public surfaces match the L-001 lock and/);
    expect(body).toMatch(/the canonical wire shape\./);
    expect(body).toMatch(/The class of bug that produced V-032's/);
    expect(body).toMatch(/scroll silent-noop and the Go `time_ms` silent-noop is now caught/);
    expect(body).toMatch(/locally in all three SDKs by wire-shape tests\./);
    expect(body).toMatch(/Next: entity-org transition prep \(KvK 2026-05-21\)\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
