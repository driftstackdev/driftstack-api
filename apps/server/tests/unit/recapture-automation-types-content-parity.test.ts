// W458.A — drift guard for packages/recapture-automation/src/types.ts.
// V-179 recapture automation types. Drift here either drops a state
// from RecaptureStatus 5-value union (caller switch loses case
// coverage and silently stalls runs on the missing terminal state)
// or weakens FingerprintComparisonOutcome 5-value union (recapture
// validator treats 'new_surface' as a match and silently ships a
// drifted baseline).
//
//   • V-179 framing pinned + workflow rationale 'When Apple ships
//     a new iOS minor version (e.g. iOS 18.7 → iOS 18.8), the
//     entire fingerprint reference set captured against the old
//     version MAY have drifted.'
//   • Phase-3 manual workflow framing pinned 'Today the workflow
//     is manual: when Agent 1 notices a new iOS version on Apple's
//     release notes, the founder runs the BS Automate capture
//     batches manually. This package's mock implementation models
//     the SAME workflow programmatically so a future scheduled-job
//     + alerting layer can drop in.'
//   • IosArchetypeVersion: 2-field (iosVersion '18.7' + safariVersion
//     '26.4').
//   • RecaptureTrigger: 4-value union (ios_version_bump +
//     safari_version_bump + baseline_drift_detected + manual_request).
//   • RecaptureStatus: 5-value union (queued + in_progress +
//     completed + failed + cancelled).
//   • FingerprintComparisonOutcome: 5-value union with per-outcome
//     framing pinned (match 'byte-for-byte' + diff 'baseline is
//     now stale' + capture_error 'network, timeout, browser crash'
//     + new_surface 'new since last capture' + missing_surface 'no
//     longer reachable').
//   • FingerprintComparison: 5-field (surfaceId 'file 121 category
//     + sub-id (e.g. webgl.G3.renderer)' + outcome + baselineValue
//     nullable + recapturedValue nullable + notes nullable).
//   • RecaptureRun framing pinned: 'A run targets ONE archetype'
//     + 13-field shape with aggregate counts (matchCount, diffCount,
//     errorCount, newSurfaceCount, missingSurfaceCount).
//   • TriggerRecaptureOpts: 4-field + optional reason.
//   • IosVersionTransition: 4-field (fromIosVersion + toIosVersion
//     + detectedAtMs + source 'Free-form source of the transition
//     (URL, file path, notebook entry)' + 'The detection layer is
//     OUT OF SCOPE for this package').

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W458.A packages/recapture-automation/src/types.ts content parity', () => {
  const body = read(LIB);

  it("V-179 framing pinned: 'V-179 — recapture automation types.' + workflow rationale 'When Apple ships a new iOS minor version (e.g. iOS 18.7 → iOS 18.8), the entire fingerprint reference set captured against the old version MAY have drifted. Recapture automation detects the version bump, triggers a recapture pass against representative archetypes, and validates that the new captures match the prior baseline (or surfaces a diff for manual review).'", () => {
    expect(body).toMatch(/\/\/ V-179 — recapture automation types\./);
    expect(body).toMatch(
      /\/\/ When Apple ships a new iOS minor version \(e\.g\. iOS 18\.7 → iOS 18\.8\),\s*\n?\s*\/\/ the entire fingerprint reference set captured against the old version\s*\n?\s*\/\/ MAY have drifted\. Recapture automation detects the version bump,\s*\n?\s*\/\/ triggers a recapture pass against representative archetypes, and\s*\n?\s*\/\/ validates that the new captures match the prior baseline \(or surfaces\s*\n?\s*\/\/ a diff for manual review\)\./,
    );
  });

  it("Phase-3 manual-workflow framing pinned: 'Today the workflow is manual: when Agent 1 notices a new iOS version on Apple's release notes, the founder runs the BS Automate capture batches manually. This package's mock implementation models the SAME workflow programmatically so a future scheduled-job + alerting layer can drop in.'", () => {
    expect(body).toMatch(
      /\/\/ Phase 3\+ workstream\. Today the workflow is manual: when Agent 1\s*\n?\s*\/\/ notices a new iOS version on Apple's release notes, the founder runs\s*\n?\s*\/\/ the BS Automate capture batches manually\. This package's mock\s*\n?\s*\/\/ implementation models the SAME workflow programmatically so a future\s*\n?\s*\/\/ scheduled-job \+ alerting layer can drop in\./,
    );
  });

  it("IosArchetypeVersion: 2-field (iosVersion '18.7' example + safariVersion '26.4' example)", () => {
    expect(body).toMatch(
      /\/\*\* Identifier for a particular iOS \+ Safari version pair\. \*\/\s*\n?\s*export interface IosArchetypeVersion \{\s*\n?\s*\/\*\* iOS major\.minor version, e\.g\. `'18\.7'`\. \*\/\s*\n?\s*iosVersion: string;\s*\n?\s*\/\*\* Safari major\.minor version, e\.g\. `'26\.4'`\. \*\/\s*\n?\s*safariVersion: string;\s*\n?\s*\}/,
    );
  });

  it("RecaptureTrigger: 4-value union ('ios_version_bump' | 'safari_version_bump' | 'baseline_drift_detected' | 'manual_request')", () => {
    expect(body).toMatch(
      /\/\*\* Why a recapture run was triggered\. \*\/\s*\n?\s*export type RecaptureTrigger =\s*\n?\s*\| 'ios_version_bump'\s*\n?\s*\| 'safari_version_bump'\s*\n?\s*\| 'baseline_drift_detected'\s*\n?\s*\| 'manual_request';/,
    );
  });

  it("RecaptureStatus: 5-value union ('queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled')", () => {
    expect(body).toMatch(
      /\/\*\* Status of a recapture run\. \*\/\s*\n?\s*export type RecaptureStatus = 'queued' \| 'in_progress' \| 'completed' \| 'failed' \| 'cancelled';/,
    );
  });

  it("FingerprintComparisonOutcome: 5-value union with per-outcome framing pinned (match 'byte-for-byte' + diff 'baseline is now stale' + capture_error '(network, timeout, browser crash)' + new_surface 'new since last capture' + missing_surface 'no longer reachable')", () => {
    expect(body).toMatch(
      /\/\*\* Per-fingerprint comparison outcome from a recapture validation\. \*\/\s*\n?\s*export type FingerprintComparisonOutcome =\s*\n?\s*\/\*\* Recaptured value matches baseline byte-for-byte\. \*\/\s*\n?\s*\| 'match'\s*\n?\s*\/\*\* Recaptured value differs; baseline is now stale\. \*\/\s*\n?\s*\| 'diff'\s*\n?\s*\/\*\* Capture failed at this surface \(network, timeout, browser crash\)\. \*\/\s*\n?\s*\| 'capture_error'\s*\n?\s*\/\*\* Surface didn't exist in baseline; new since last capture\. \*\/\s*\n?\s*\| 'new_surface'\s*\n?\s*\/\*\* Surface existed in baseline but no longer reachable\. \*\/\s*\n?\s*\| 'missing_surface';/,
    );
  });

  it("FingerprintComparison: 5-field (surfaceId 'file 121 category + sub-id (e.g. webgl.G3.renderer)' framing + outcome + baselineValue nullable + recapturedValue nullable + notes nullable 'Free-form reason when outcome != match')", () => {
    expect(body).toMatch(
      /export interface FingerprintComparison \{\s*\n?\s*\/\*\* Surface identifier — file 121 category \+ sub-id \(e\.g\. `'webgl\.G3\.renderer'`\)\. \*\/\s*\n?\s*surfaceId: string;\s*\n?\s*outcome: FingerprintComparisonOutcome;\s*\n?\s*baselineValue: string \| null;\s*\n?\s*recapturedValue: string \| null;\s*\n?\s*\/\*\* Free-form reason when outcome != 'match'\. \*\/\s*\n?\s*notes: string \| null;\s*\n?\s*\}/,
    );
  });

  it("RecaptureRun framing pinned: 'One recapture run. A run targets ONE archetype (defined by archetypeId + the iOS/Safari version pair). The per-surface comparisons accumulate into the comparisons array as the run progresses; on completion, the aggregate matchCount / diffCount / errorCount reflect the validation outcome.'", () => {
    expect(body).toMatch(
      /\* One recapture run\. A run targets ONE archetype \(defined by\s*\n?\s*\*\s*archetypeId \+ the iOS\/Safari version pair\)\. The per-surface\s*\n?\s*\*\s*comparisons accumulate into the `comparisons` array as the run\s*\n?\s*\*\s*progresses; on completion, the aggregate `matchCount` \/\s*\n?\s*\*\s*`diffCount` \/ `errorCount` reflect the validation outcome\./,
    );
  });

  it("RecaptureRun: 13-field shape (id + trigger + archetypeId 'iphone16pro_ios18_7_safari26_4' example + baselineVersion + targetVersion 'May equal baselineVersion for manual reruns' + status + comparisons readonly 'Empty until the run starts' + 5 aggregate counts (matchCount + diffCount + errorCount + newSurfaceCount + missingSurfaceCount) + startedAtMs nullable + completedAtMs nullable + createdAtMs)", () => {
    expect(body).toMatch(
      /export interface RecaptureRun \{\s*\n?\s*id: string;[\s\S]*?trigger: RecaptureTrigger;[\s\S]*?\/\*\* Archetype being recaptured, e\.g\. `'iphone16pro_ios18_7_safari26_4'`\. \*\/\s*\n?\s*archetypeId: string;[\s\S]*?baselineVersion: IosArchetypeVersion;[\s\S]*?\/\*\* New version triggering the recapture\. May equal baselineVersion for manual reruns\. \*\/\s*\n?\s*targetVersion: IosArchetypeVersion;[\s\S]*?status: RecaptureStatus;[\s\S]*?\/\*\* Per-fingerprint comparisons\. Empty until the run starts\. \*\/\s*\n?\s*comparisons: readonly FingerprintComparison\[\];[\s\S]*?matchCount: number;[\s\S]*?diffCount: number;[\s\S]*?errorCount: number;[\s\S]*?newSurfaceCount: number;[\s\S]*?missingSurfaceCount: number;[\s\S]*?startedAtMs: number \| null;[\s\S]*?completedAtMs: number \| null;[\s\S]*?createdAtMs: number;/,
    );
  });

  it("TriggerRecaptureOpts: 4-field (trigger + archetypeId + baselineVersion + targetVersion) + optional reason 'Apple release notes reference 18.8 dropped 2026-08-01' example", () => {
    expect(body).toMatch(
      /\/\*\* Parameters for triggering a new recapture\. \*\/\s*\n?\s*export interface TriggerRecaptureOpts \{\s*\n?\s*trigger: RecaptureTrigger;\s*\n?\s*archetypeId: string;\s*\n?\s*baselineVersion: IosArchetypeVersion;\s*\n?\s*targetVersion: IosArchetypeVersion;\s*\n?\s*\/\*\* Optional human-readable note \(e\.g\. "Apple release notes reference 18\.8 dropped 2026-08-01"\)\. \*\/\s*\n?\s*reason\?: string;\s*\n?\s*\}/,
    );
  });

  it("IosVersionTransition framing pinned: 'Detected iOS version transition. Today this comes from manual inspection of Apple's release notes; future: scraper / RSS feed watcher. The detection layer is OUT OF SCOPE for this package — this type is the boundary the detection layer hands off to the recapture trigger.' + 4-field (fromIosVersion + toIosVersion + detectedAtMs + source)", () => {
    expect(body).toMatch(
      /\* Detected iOS version transition\. Today this comes from manual\s*\n?\s*\*\s*inspection of Apple's release notes; future: scraper \/ RSS feed\s*\n?\s*\*\s*watcher\. The detection layer is OUT OF SCOPE for this package —\s*\n?\s*\*\s*this type is the boundary the detection layer hands off to the\s*\n?\s*\*\s*recapture trigger\./,
    );
    expect(body).toMatch(
      /export interface IosVersionTransition \{\s*\n?\s*fromIosVersion: string;\s*\n?\s*toIosVersion: string;\s*\n?\s*detectedAtMs: number;\s*\n?\s*\/\*\* Free-form source of the transition \(URL, file path, notebook entry\)\. \*\/\s*\n?\s*source: string;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
