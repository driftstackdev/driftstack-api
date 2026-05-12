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
      /\/\/ First sub-slice of V-533 per the anti-substitution clause\. Extends the\s*\n?\s*\/\/ recapture-automation package from per-run primitives \(V-179\) to a\s*\n?\s*\/\/ matrix-level orchestration layer:/,
    );
  });

  it("3-method scope pinned: (1) expandCaptureMatrix(spec) fan-out (archetypeIds × version-transition) + (2) dedupComparisons collapse duplicate tuples 'Matrix runs against multiple iOS minor versions can produce the same surface comparison multiple times — dedup avoids polluting the atlas builder downstream.'", () => {
    expect(body).toMatch(
      /\/\/\s+1\. `expandCaptureMatrix\(spec\)` — fan out a \(archetypeIds × version-\s*\n?\s*\/\/\s+transition\) spec into per-archetype `TriggerRecaptureOpts`\./,
    );
    expect(body).toMatch(
      /\/\/\s+2\. `dedupComparisons\(comparisons\)` — collapse duplicate\s*\n?\s*\/\/\s+\(surfaceId, baselineValue, recapturedValue\) tuples to a canonical\s*\n?\s*\/\/\s+list\. Matrix runs against multiple iOS minor versions can produce\s*\n?\s*\/\/\s+the same surface comparison multiple times — dedup avoids polluting\s*\n?\s*\/\/\s+the atlas builder downstream\./,
    );
  });

  it("Cross-agent contract framing pinned: 'Agent 1's fork-side capture code calls into the RecaptureService (V-179) interface; this matrix layer wraps that service for multi-archetype orchestration on this side.' + `docs/internal/v533-cross-agent-contract.md` reference", () => {
    expect(body).toMatch(
      /\/\/ Cross-agent contract: Agent 1's fork-side capture code calls into the\s*\n?\s*\/\/ `RecaptureService` \(V-179\) interface; this matrix layer wraps that\s*\n?\s*\/\/ service for multi-archetype orchestration on this side\. See\s*\n?\s*\/\/ `docs\/internal\/v533-cross-agent-contract\.md`\./,
    );
  });

  it("V-533.B/.C sub-slice references pinned: V-533.B atlas builder 'aggregate completed runs into a per-archetype version-axis atlas' + V-533.C scheduled-job driver 'cron / interval that watches for iOS version bumps and triggers matrix runs automatically'", () => {
    expect(body).toMatch(
      /\/\/\s+- V-533\.B \(later\) — atlas builder service API \(aggregate completed\s*\n?\s*\/\/\s+runs into a per-archetype version-axis atlas\)\.\s*\n?\s*\/\/\s+- V-533\.C \(later\) — scheduled-job driver \(cron \/ interval that watches\s*\n?\s*\/\/\s+for iOS version bumps and triggers matrix runs automatically\)\./,
    );
  });

  it('CaptureMatrixSpec: 5-field (archetypeIds readonly string[] + baselineVersion + targetVersion + trigger + reason optional)', () => {
    expect(body).toMatch(
      /export interface CaptureMatrixSpec \{\s*\n?\s*\/\*\* Archetypes to recapture\. At least 1\. \*\/\s*\n?\s*archetypeIds: readonly string\[\];\s*\n?\s*\/\*\* Baseline iOS \+ Safari version pair\. Same for all archetypes\. \*\/\s*\n?\s*baselineVersion: IosArchetypeVersion;\s*\n?\s*\/\*\* Target \(post-bump\) iOS \+ Safari version pair\. \*\/\s*\n?\s*targetVersion: IosArchetypeVersion;\s*\n?\s*\/\*\* Why this matrix is running\. \*\/\s*\n?\s*trigger: RecaptureTrigger;\s*\n?\s*\/\*\* Optional reason string applied uniformly to every produced run spec\. \*\/\s*\n?\s*reason\?: string;\s*\n?\s*\}/,
    );
  });

  it("expandCaptureMatrix: empty-array throw 'expandCaptureMatrix: archetypeIds must contain at least 1 entry' + output order matches input archetypeIds + reason conditional spread", () => {
    expect(body).toMatch(
      /if \(spec\.archetypeIds\.length === 0\) \{\s*\n?\s*throw new Error\('expandCaptureMatrix: archetypeIds must contain at least 1 entry'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /return spec\.archetypeIds\.map\(\(archetypeId\) => \{\s*\n?\s*const opts: TriggerRecaptureOpts = \{\s*\n?\s*trigger: spec\.trigger,\s*\n?\s*archetypeId,\s*\n?\s*baselineVersion: spec\.baselineVersion,\s*\n?\s*targetVersion: spec\.targetVersion,\s*\n?\s*\};\s*\n?\s*if \(spec\.reason !== undefined\) \{\s*\n?\s*opts\.reason = spec\.reason;\s*\n?\s*\}\s*\n?\s*return opts;\s*\n?\s*\}\);/,
    );
  });

  it("dedupKey: (surfaceId, outcome, baselineValue ?? '', recapturedValue ?? '').join(' ') 4-tuple framing pinned + 'notes and other free-form fields are dropped from the dedup key — they may differ by run timestamp / capture environment without changing the semantic outcome'", () => {
    expect(body).toMatch(
      /\* Dedup key for a comparison\. Two comparisons with identical \(surfaceId,\s*\n?\s*\*\s*baselineValue, recapturedValue, outcome\) collapse to one\. `notes` and\s*\n?\s*\*\s*other free-form fields are dropped from the dedup key — they may differ\s*\n?\s*\*\s*by run timestamp \/ capture environment without changing the semantic\s*\n?\s*\*\s*outcome\./,
    );
    expect(body).toMatch(
      /function dedupKey\(c: FingerprintComparison\): string \{\s*\n?\s*return \[c\.surfaceId, c\.outcome, c\.baselineValue \?\? '', c\.recapturedValue \?\? ''\]\.join\('.'\);\s*\n?\s*\}/,
    );
  });

  it("dedupComparisons: 'first occurrence wins' + 'Stable wrt input order' + atlas-builder framing 'merge per-run comparison lists into a single per-archetype-version reference set without double-counting'", () => {
    expect(body).toMatch(
      /\*\s*Collapse duplicate comparisons\. The first occurrence of each dedup key\s*\n?\s*\*\s*wins; subsequent duplicates are dropped\. Stable wrt input order\./,
    );
    expect(body).toMatch(
      /\*\s*Used by the atlas builder \(V-533\.B\) to merge per-run comparison lists\s*\n?\s*\*\s*into a single per-archetype-version reference set without\s*\n?\s*\*\s*double-counting surfaces that appeared in multiple runs\./,
    );
    expect(body).toMatch(
      /export function dedupComparisons\(\s*\n?\s*comparisons: readonly FingerprintComparison\[\],\s*\n?\s*\): readonly FingerprintComparison\[\] \{\s*\n?\s*const seen = new Set<string>\(\);\s*\n?\s*const out: FingerprintComparison\[\] = \[\];\s*\n?\s*for \(const c of comparisons\) \{\s*\n?\s*const key = dedupKey\(c\);\s*\n?\s*if \(!seen\.has\(key\)\) \{\s*\n?\s*seen\.add\(key\);\s*\n?\s*out\.push\(c\);\s*\n?\s*\}\s*\n?\s*\}\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it("groupComparisonsByCategory: 'file-121 category prefix before the first .' framing pinned + 'webgl.G3.renderer' → category 'webgl' example + dotIndex === -1 fallback to full surfaceId + noUncheckedIndexedAccess guard framing", () => {
    expect(body).toMatch(
      /\*\s*Group comparisons by surface category — the file-121 category prefix\s*\n?\s*\*\s*before the first '\.' in surfaceId\. E\.g\. 'webgl\.G3\.renderer' →\s*\n?\s*\*\s*category 'webgl'\./,
    );
    expect(body).toMatch(
      /const dotIndex = c\.surfaceId\.indexOf\('\.'\);\s*\n?\s*const category = dotIndex === -1 \? c\.surfaceId : c\.surfaceId\.slice\(0, dotIndex\);/,
    );
    expect(body).toMatch(
      /\/\/ Bracket access on a record that's keyed by `string` returns\s*\n?\s*\/\/ `T \| undefined` under noUncheckedIndexedAccess\. The `in buckets`\s*\n?\s*\/\/ check above plus the immediate assignment narrow it, but\s*\n?\s*\/\/ TypeScript can't always see through to a non-null guarantee\./,
    );
  });

  it("ComparisonSummary: 6-field (total + matchCount + diffCount + errorCount + newSurfaceCount + missingSurfaceCount); summarizeComparisons switch on c.outcome with 5 cases (match/diff/capture_error/new_surface/missing_surface) + '9 surfaces match, 2 diff, 1 capture error, 0 new, 0 missing' style readout framing", () => {
    expect(body).toMatch(
      /\*\s*Summary stats for a comparison list\. Used by the atlas builder to\s*\n?\s*\*\s*surface "9 surfaces match, 2 diff, 1 capture error, 0 new, 0 missing"\s*\n?\s*\*\s*style readouts\./,
    );
    expect(body).toMatch(
      /export interface ComparisonSummary \{\s*\n?\s*total: number;\s*\n?\s*matchCount: number;\s*\n?\s*diffCount: number;\s*\n?\s*errorCount: number;\s*\n?\s*newSurfaceCount: number;\s*\n?\s*missingSurfaceCount: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /switch \(c\.outcome\) \{\s*\n?\s*case 'match':\s*\n?\s*summary\.matchCount \+= 1;\s*\n?\s*break;\s*\n?\s*case 'diff':\s*\n?\s*summary\.diffCount \+= 1;\s*\n?\s*break;\s*\n?\s*case 'capture_error':\s*\n?\s*summary\.errorCount \+= 1;\s*\n?\s*break;\s*\n?\s*case 'new_surface':\s*\n?\s*summary\.newSurfaceCount \+= 1;\s*\n?\s*break;\s*\n?\s*case 'missing_surface':\s*\n?\s*summary\.missingSurfaceCount \+= 1;\s*\n?\s*break;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
