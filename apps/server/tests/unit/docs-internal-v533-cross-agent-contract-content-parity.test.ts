// W567.A — drift guard for /docs/internal/v533-cross-agent-contract.md.
// V-533 STAGED doc 2026-05-10 Wave-20. Drift here either re-scopes the
// Agent 2 (driftstack-api) orchestration vs Agent 1 (webkit-driftstack)
// capture-worker split, drops the dedup contract semantics, or unsets
// the V-533.A/B/C sub-slice deferral posture.
//
//   • V-533. STAGED. Builds on V-179 per-run primitives.
//   • Matrix orchestration + dedup + summary/grouping helpers.
//   • Rule G: Agent 2 does NOT touch webkit-driftstack.
//   • Transport: in-process for tests, /v1/admin/recapture/runs/*
//     deferred to V-533.C.
//   • Dedup key: (surfaceId, outcome, baselineValue, recapturedValue);
//     notes field NOT part of key.
//   • Change-management: coordinated commit pair for orchestration
//     surface changes affecting Agent 1's worker calls.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v533-cross-agent-contract.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W567.A /docs/internal/v533-cross-agent-contract.md content parity', () => {
  const body = read(LIB);

  it("Header + V-533-STAGED-Wave-20 + V-179-V-533.A-V-533.B-orchestration + Rule-G-Agent2-no-webkit framing pinned: '# V-533 — cross-agent contract: recapture orchestration' + '**Date:** 2026-05-10' + '**Wave:** 20' + '**Status:** STAGED — orchestration primitives in' + '`packages/recapture-automation/src/matrix.ts`; fork-side capture worker is' + 'Agent 1' + 'V-179 shipped the per-run + per-comparison primitives' + '(`RecaptureService`, `RecaptureRun`, `FingerprintComparison`). V-533' + 'adds the matrix-level orchestration: fan out a multi-archetype recapture' + 'across (archetype × ios-version × surface) tuples, dedup, and (in' + 'V-533.B) aggregate completed runs into a per-archetype atlas.' + 'The actual capture work — opening a WKWebView, navigating to each file-' + '121 surface URL, extracting the fingerprint value — lives on Agent 1' + 'side in the webkit-driftstack fork. This repo provides the' + '**orchestration service Agent 1 calls into**, never the capture code' + 'itself.' + 'Per Rule G, this repo (Agent 2) does NOT touch the webkit-driftstack' + 'repo. Agent 1 picks up the worker implementation in coordination with' + 'this contract.' — pinned so the V-533-STAGED-Wave-20-2026-05-10 + V-179-base + V-533.A-matrix + V-533.B-atlas + Rule-G-Agent2-orchestration-only commitment survives", () => {
    expect(body).toMatch(/^# V-533 — cross-agent contract: recapture orchestration$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-10/);
    expect(body).toMatch(/\*\*Wave:\*\* 20/);
    expect(body).toMatch(/\*\*Status:\*\* STAGED — orchestration primitives in/);
    expect(body).toMatch(
      /`packages\/recapture-automation\/src\/matrix\.ts`; fork-side capture worker is/,
    );
    expect(body).toMatch(/Agent 1's scope\./);
    expect(body).toMatch(/V-179 shipped the per-run \+ per-comparison primitives/);
    expect(body).toMatch(/\(`RecaptureService`, `RecaptureRun`, `FingerprintComparison`\)\. V-533/);
    expect(body).toMatch(
      /adds the matrix-level orchestration: fan out a multi-archetype recapture/,
    );
    expect(body).toMatch(/across \(archetype × ios-version × surface\) tuples, dedup, and \(in/);
    expect(body).toMatch(/V-533\.B\) aggregate completed runs into a per-archetype atlas\./);
    expect(body).toMatch(/121 surface URL, extracting the fingerprint value — lives on Agent 1's/);
    expect(body).toMatch(/side in the webkit-driftstack fork\. This repo provides the/);
    expect(body).toMatch(
      /\*\*orchestration service Agent 1 calls into\*\*, never the capture code/,
    );
    expect(body).toMatch(/Per Rule G, this repo \(Agent 2\) does NOT touch the webkit-driftstack/);
    expect(body).toMatch(/repo\. Agent 1 picks up the worker implementation in coordination with/);
  });

  it("Call protocol + Transport + Matrix-runner + expandCaptureMatrix framing pinned: '## Call protocol' + '(1) admin triggers a matrix recapture' + 'expandCaptureMatrix(spec)' + '→ N TriggerRecaptureOpts' + 'N × triggerRecapture()' + '(2) Agent 1 worker polls listRuns({status: ' + 'recordComparison()' + 'finalizeRun(completed)' + '(3) admin reviews atlas' + '## Transport' + 'Today, the `MockRecaptureService` lives in-process for tests. Production' + 'transport between Agent 1' + '`RecaptureService` impl is HTTP via the admin API surface — `/v1/admin/' + 'recapture/runs/*` endpoints (NOT YET IMPLEMENTED; deferred to V-533.C).' + '## Matrix runner contract' + 'archetypeIds: [' + 'baselineVersion: { iosVersion: ' + 'targetVersion: { iosVersion: ' + 'trigger: ' + 'reason: ' — pinned so the (1)-admin-trigger + (2)-Agent1-poll + (3)-admin-atlas + MockRecaptureService-in-process + /v1/admin/recapture/runs/*-deferred-V-533.C + CaptureMatrixSpec-archetypeIds/baseline/target/trigger/reason commitment survives", () => {
    expect(body).toMatch(/## Call protocol/);
    expect(body).toMatch(/\(1\) admin triggers a matrix recapture/);
    expect(body).toMatch(/expandCaptureMatrix\(spec\)/);
    expect(body).toMatch(/→ N TriggerRecaptureOpts/);
    expect(body).toMatch(/N × triggerRecapture\(\)/);
    expect(body).toMatch(
      /\(2\) Agent 1 worker polls listRuns\(\{status: 'queued'\}\) periodically/,
    );
    expect(body).toMatch(/recordComparison\(\)/);
    expect(body).toMatch(/finalizeRun\(completed\)/);
    expect(body).toMatch(/\(3\) admin reviews atlas/);
    expect(body).toMatch(/## Transport/);
    expect(body).toMatch(
      /Today, the `MockRecaptureService` lives in-process for tests\. Production/,
    );
    expect(body).toMatch(/transport between Agent 1's fork worker and Agent 2's control-plane/);
    expect(body).toMatch(
      /`RecaptureService` impl is HTTP via the admin API surface — `\/v1\/admin\//,
    );
    expect(body).toMatch(
      /recapture\/runs\/\*` endpoints \(NOT YET IMPLEMENTED; deferred to V-533\.C\)\./,
    );
    expect(body).toMatch(/## Matrix runner contract/);
    expect(body).toMatch(/archetypeIds: \['iphone16pro_ios18_7_safari26_4' \/\* … \*\/\],/);
    expect(body).toMatch(/baselineVersion: \{ iosVersion: '18\.7', safariVersion: '26\.4' \},/);
    expect(body).toMatch(/targetVersion: \{ iosVersion: '18\.8', safariVersion: '26\.5' \},/);
    expect(body).toMatch(/trigger: 'ios_version_bump',/);
    expect(body).toMatch(/reason: 'Apple release notes 2026-08-01 announced iOS 18\.8',/);
  });

  it("Dedup contract + Summary/grouping helpers + Sub-slices + Change-management framing pinned: '## Dedup contract' + '`dedupComparisons(comparisons)`: when the atlas builder (V-533.B) merges' + 'per-run comparison lists into a per-archetype reference set, duplicate' + '`(surfaceId, outcome, baselineValue, recapturedValue)` tuples collapse' + 'to a single entry. The first occurrence wins; subsequent are dropped.' + '`notes` field is NOT part of the dedup key — two runs with identical' + 'semantic outcomes but different operator notes collapse to one.' + '## Summary / grouping helpers' + '`summarizeComparisons(list)` → counts per outcome type. Used by the' + 'admin-panel pivot table.' + '`groupComparisonsByCategory(list)` → splits by file-121 category' + 'prefix (everything before the first dot in `surfaceId`).' + '## Sub-slices' + '**V-533.A (THIS WAVE):** matrix runner + dedup + summary/grouping +' + '**V-533.B (later):** atlas builder service API.' + '**V-533.C (later):** admin routes — `/v1/admin/recapture/runs` GET +' + 'POST + `/v1/admin/recapture/atlas/{archetypeId}` GET. Production HTTP' + 'transport between Agent 1 worker + Agent 2 service.' + '## Change-management protocol' + 'ANY change to the orchestration surface that affects how Agent 1' + 'worker calls in (e.g. renaming `recordComparison` or changing its' + 'shape) requires a coordinated commit pair — one in this repo, one in' + 'webkit-driftstack — referencing the same V-533-update slice.' — pinned so the dedup-key-(surfaceId+outcome+baseline+recaptured)-first-wins + notes-NOT-in-key + summarizeComparisons-pivot + groupComparisonsByCategory-first-dot + V-533.A-matrix-runner + V-533.B-atlas-builder + V-533.C-admin-routes + change-management-coordinated-commit-pair commitment survives", () => {
    expect(body).toMatch(/## Dedup contract/);
    expect(body).toMatch(
      /`dedupComparisons\(comparisons\)`: when the atlas builder \(V-533\.B\) merges/,
    );
    expect(body).toMatch(/per-run comparison lists into a per-archetype reference set, duplicate/);
    expect(body).toMatch(
      /`\(surfaceId, outcome, baselineValue, recapturedValue\)` tuples collapse/,
    );
    expect(body).toMatch(/to a single entry\. The first occurrence wins; subsequent are dropped\./);
    expect(body).toMatch(/`notes` field is NOT part of the dedup key — two runs with identical/);
    expect(body).toMatch(/semantic outcomes but different operator notes collapse to one\./);
    expect(body).toMatch(/## Summary \/ grouping helpers/);
    expect(body).toMatch(/`summarizeComparisons\(list\)` → counts per outcome type\. Used by the/);
    expect(body).toMatch(/admin-panel pivot table\./);
    expect(body).toMatch(/`groupComparisonsByCategory\(list\)` → splits by file-121 category/);
    expect(body).toMatch(/prefix \(everything before the first dot in `surfaceId`\)\./);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(
      /\*\*V-533\.A \(THIS WAVE\):\*\* matrix runner \+ dedup \+ summary\/grouping \+/,
    );
    expect(body).toMatch(/\*\*V-533\.B \(later\):\*\* atlas builder service API\./);
    expect(body).toMatch(
      /\*\*V-533\.C \(later\):\*\* admin routes — `\/v1\/admin\/recapture\/runs` GET \+/,
    );
    expect(body).toMatch(
      /POST \+ `\/v1\/admin\/recapture\/atlas\/\{archetypeId\}` GET\. Production HTTP/,
    );
    expect(body).toMatch(/transport between Agent 1 worker \+ Agent 2 service\./);
    expect(body).toMatch(/## Change-management protocol/);
    expect(body).toMatch(/ANY change to the orchestration surface that affects how Agent 1's/);
    expect(body).toMatch(/worker calls in \(e\.g\. renaming `recordComparison` or changing its/);
    expect(body).toMatch(/shape\) requires a coordinated commit pair — one in this repo, one in/);
    expect(body).toMatch(/webkit-driftstack — referencing the same V-533-update slice\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
