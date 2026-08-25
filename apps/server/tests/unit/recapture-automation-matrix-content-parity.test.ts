// W460.A — drift guard for packages/recapture-automation/src/matrix.ts.
// V-533.A capture-matrix runner + dedup. Drift here either drops the
// (surfaceId, outcome, baselineValue, recapturedValue) dedup key
// (atlas builder silently double-counts surfaces that appeared in
// multiple matrix runs) or breaks the category-prefix split on
// surfaceId (groupComparisonsByCategory loses bucket invariants and
// admin pivot tables show mis-bucketed counts).
//
//   • V-533.A framing pinned + 'First sub-slice of V-533 per the
//     anti-substitution clause' + 3-method scope (expandCaptureMatrix
//     + dedupComparisons + groupComparisonsByCategory).
//   • Cross-agent contract framing: 'Agent 1's fork-side capture code
//     calls into the RecaptureService (V-179) interface' +
//     `docs/internal/v533-cross-agent-contract.md` reference.
//   • V-533.B/.C sub-slice references pinned (atlas builder service
//     API + scheduled-job driver).
//   • CaptureMatrixSpec: 5-field (archetypeIds readonly string[] +
//     baselineVersion + targetVersion + trigger + reason optional).
//   • expandCaptureMatrix: empty-array throw 'archetypeIds must contain
//     at least 1 entry' + output order matches input archetypeIds +
//     reason conditional spread.
//   • dedupKey: (surfaceId, outcome, baselineValue ?? '',
//     recapturedValue ?? '').join(' ') 4-tuple framing pinned.
//   • dedupComparisons: 'first occurrence wins' + 'Stable wrt input
//     order' + atlas-builder framing pinned.
//   • groupComparisonsByCategory: 'file-121 category prefix before the
//     first .' + dotIndex === -1 fallback to full surfaceId +
//     noUncheckedIndexedAccess guard framing pinned.
//   • ComparisonSummary: 6-field (total + 5 outcome counts) +
//     summarizeComparisons switch on c.outcome with 5 cases.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/matrix.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W460.A packages/recapture-automation/src/matrix.ts content parity', () => {
  const body = read(LIB);

  it("V-533.A framing pinned: 'V-533.A — capture-matrix runner + dedup.' + 'First sub-slice of V-533 per the anti-substitution clause' + extends V-179 per-run primitives to matrix-level orchestration", () => {
    expect(body).toMatch(/\/\/ V-533\.A — capture-matrix runner \+ dedup\./);
    expect(body).toMatch(
      /\/\/ First sub-slice of V-533 per the anti-substitution clause\. Extends the\s*\/\/ recapture-automation package from per-run primitives \(V-179\) to a\s*\/\/ matrix-level orchestration layer:/,
    );
  });

  it("3-method scope pinned: (1) expandCaptureMatrix(spec) fan-out (archetypeIds × version-transition) + (2) dedupComparisons collapse duplicate tuples 'Matrix runs against multiple iOS minor versions can produce the same surface comparison multiple times — dedup avoids polluting the atlas builder downstream.'", () => {
    expect(body).toMatch(
      /\/\/\s+1\. `expandCaptureMatrix\(spec\)` — fan out a \(archetypeIds × version-\s*\/\/\s+transition\) spec into per-archetype `TriggerRecaptureOpts`\./,
    );
    expect(body).toMatch(
      /\/\/\s+2\. `dedupComparisons\(comparisons\)` — collapse duplicate\s*\/\/\s+\(surfaceId, baselineValue, recapturedValue\) tuples to a canonical\s*\/\/\s+list\. Matrix runs against multiple iOS minor versions can produce\s*\/\/\s+the same surface comparison multiple times — dedup avoids polluting\s*\/\/\s+the atlas builder downstream\./,
    );
  });

  it("Cross-agent contract framing pinned: 'Agent 1's fork-side capture code calls into the RecaptureService (V-179) interface; this matrix layer wraps that service for multi-archetype orchestration on this side.' + `docs/internal/v533-cross-agent-contract.md` reference", () => {
    expect(body).toMatch(
      /\/\/ Cross-agent contract: Agent 1's fork-side capture code calls into the\s*\/\/ `RecaptureService` \(V-179\) interface; this matrix layer wraps that\s*\/\/ service for multi-archetype orchestration on this side\. See\s*\/\/ `docs\/internal\/v533-cross-agent-contract\.md`\./,
    );
  });

  it("V-533.B/.C sub-slice references pinned: V-533.B atlas builder 'aggregate completed runs into a per-archetype version-axis atlas' + V-533.C scheduled-job driver 'cron / interval that watches for iOS version bumps and triggers matrix runs automatically'", () => {
    expect(body).toMatch(
      /\/\/\s+- V-533\.B \(later\) — atlas builder service API \(aggregate completed\s*\/\/\s+runs into a per-archetype version-axis atlas\)\.\s*\/\/\s+- V-533\.C \(later\) — scheduled-job driver \(cron \/ interval that watches\s*\/\/\s+for iOS version bumps and triggers matrix runs automatically\)\./,
    );
  });

  it('CaptureMatrixSpec: 5-field (archetypeIds readonly string[] + baselineVersion + targetVersion + trigger + reason optional)', () => {
    expect(body).toMatch(
      /export interface CaptureMatrixSpec \{\s*\/\*\* Archetypes to recapture\. At least 1\. \*\/\s*archetypeIds: readonly string\[\];\s*\/\*\* Baseline iOS \+ Safari version pair\. Same for all archetypes\. \*\/\s*baselineVersion: IosArchetypeVersion;\s*\/\*\* Target \(post-bump\) iOS \+ Safari version pair\. \*\/\s*targetVersion: IosArchetypeVersion;\s*\/\*\* Why this matrix is running\. \*\/\s*trigger: RecaptureTrigger;\s*\/\*\* Optional reason string applied uniformly to every produced run spec\. \*\/\s*reason\?: string;\s*\}/,
    );
  });

  it("expandCaptureMatrix: empty-array throw 'expandCaptureMatrix: archetypeIds must contain at least 1 entry' + output order matches input archetypeIds + reason conditional spread", () => {
    expect(body).toMatch(
      /if \(spec\.archetypeIds\.length === 0\) \{\s*throw new Error\('expandCaptureMatrix: archetypeIds must contain at least 1 entry'\);\s*\}/,
    );
    expect(body).toMatch(
      /return spec\.archetypeIds\.map\(\(archetypeId\) => \{\s*const opts: TriggerRecaptureOpts = \{\s*trigger: spec\.trigger,\s*archetypeId,\s*baselineVersion: spec\.baselineVersion,\s*targetVersion: spec\.targetVersion,\s*\};\s*if \(spec\.reason !== undefined\) \{\s*opts\.reason = spec\.reason;\s*\}\s*return opts;\s*\}\);/,
    );
  });

  it("dedupKey: (surfaceId, outcome, baselineValue ?? '', recapturedValue ?? '').join(' ') 4-tuple framing pinned + 'notes and other free-form fields are dropped from the dedup key — they may differ by run timestamp / capture environment without changing the semantic outcome'", () => {
    expect(body).toMatch(
      /\* Dedup key for a comparison\. Two comparisons with identical \(surfaceId,\s*\*\s*baselineValue, recapturedValue, outcome\) collapse to one\. `notes` and\s*\*\s*other free-form fields are dropped from the dedup key — they may differ\s*\*\s*by run timestamp \/ capture environment without changing the semantic\s*\*\s*outcome\./,
    );
    expect(body).toMatch(
      /function dedupKey\(c: FingerprintComparison\): string \{\s*return \[c\.surfaceId, c\.outcome, c\.baselineValue \?\? '', c\.recapturedValue \?\? ''\]\.join\('.'\);\s*\}/,
    );
  });

  it("dedupComparisons: 'first occurrence wins' + 'Stable wrt input order' + atlas-builder framing 'merge per-run comparison lists into a single per-archetype-version reference set without double-counting'", () => {
    expect(body).toMatch(
      /\*\s*Collapse duplicate comparisons\. The first occurrence of each dedup key\s*\*\s*wins; subsequent duplicates are dropped\. Stable wrt input order\./,
    );
    expect(body).toMatch(
      /\*\s*Used by the atlas builder \(V-533\.B\) to merge per-run comparison lists\s*\*\s*into a single per-archetype-version reference set without\s*\*\s*double-counting surfaces that appeared in multiple runs\./,
    );
    expect(body).toMatch(
      /export function dedupComparisons\(\s*comparisons: readonly FingerprintComparison\[\],\s*\): readonly FingerprintComparison\[\] \{\s*const seen = new Set<string>\(\);\s*const out: FingerprintComparison\[\] = \[\];\s*for \(const c of comparisons\) \{\s*const key = dedupKey\(c\);\s*if \(!seen\.has\(key\)\) \{\s*seen\.add\(key\);\s*out\.push\(c\);\s*\}\s*\}\s*return out;\s*\}/,
    );
  });

  it("groupComparisonsByCategory: 'file-121 category prefix before the first .' framing pinned + 'webgl.G3.renderer' → category 'webgl' example + dotIndex === -1 fallback to full surfaceId + noUncheckedIndexedAccess guard framing", () => {
    expect(body).toMatch(
      /\*\s*Group comparisons by surface category — the file-121 category prefix\s*\*\s*before the first '\.' in surfaceId\. E\.g\. 'webgl\.G3\.renderer' →\s*\*\s*category 'webgl'\./,
    );
    expect(body).toMatch(
      /const dotIndex = c\.surfaceId\.indexOf\('\.'\);\s*const category = dotIndex === -1 \? c\.surfaceId : c\.surfaceId\.slice\(0, dotIndex\);/,
    );
    expect(body).toMatch(
      /\/\/ Bracket access on a record that's keyed by `string` returns\s*\/\/ `T \| undefined` under noUncheckedIndexedAccess\. The `in buckets`\s*\/\/ check above plus the immediate assignment narrow it, but\s*\/\/ TypeScript can't always see through to a non-null guarantee\./,
    );
  });

  it("ComparisonSummary: 6-field (total + matchCount + diffCount + errorCount + newSurfaceCount + missingSurfaceCount); summarizeComparisons switch on c.outcome with 5 cases (match/diff/capture_error/new_surface/missing_surface) + '9 surfaces match, 2 diff, 1 capture error, 0 new, 0 missing' style readout framing", () => {
    expect(body).toMatch(
      /\*\s*Summary stats for a comparison list\. Used by the atlas builder to\s*\*\s*surface "9 surfaces match, 2 diff, 1 capture error, 0 new, 0 missing"\s*\*\s*style readouts\./,
    );
    expect(body).toMatch(
      /export interface ComparisonSummary \{\s*total: number;\s*matchCount: number;\s*diffCount: number;\s*errorCount: number;\s*newSurfaceCount: number;\s*missingSurfaceCount: number;\s*\}/,
    );
    expect(body).toMatch(
      /switch \(c\.outcome\) \{\s*case 'match':\s*summary\.matchCount \+= 1;\s*break;\s*case 'diff':\s*summary\.diffCount \+= 1;\s*break;\s*case 'capture_error':\s*summary\.errorCount \+= 1;\s*break;\s*case 'new_surface':\s*summary\.newSurfaceCount \+= 1;\s*break;\s*case 'missing_surface':\s*summary\.missingSurfaceCount \+= 1;\s*break;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
