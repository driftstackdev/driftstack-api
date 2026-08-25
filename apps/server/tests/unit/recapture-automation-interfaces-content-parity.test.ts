// W457.B — drift guard for packages/recapture-automation/src/interfaces.ts.
// V-179 recapture automation interfaces. Drift here either drops
// the recordComparison surface (capture worker can't stream per-
// surface diffs into the run-in-progress, aggregate counts stay
// frozen) or breaks the IosVersionWatcher persistence framing
// (implementations would re-emit the same transition across cron
// runs, double-triggering recapture).
//
//   • V-179 framing pinned.
//   • imports: 5 type-only from ./types.
//   • ListRunsOpts: 4 optional fields (archetypeId + status +
//     limit default 50/max 200 + cursor); ListRunsPage: {data +
//     nextCursor}.
//   • RecaptureService framing pinned: 'Top-level recapture
//     orchestration service. Operators (founder + future
//     automation) call triggerRecapture() when a version bump is
//     detected; the service queues + runs the capture passes
//     against the configured archetypes.'
//   • 5 methods: triggerRecapture 'status queued → in_progress →
//     completed/failed' framing + getRun + listRuns + recordComparison
//     'Called by the capture worker as it walks each surface from
//     file 121 + the cumulative-rig snapshot. Aggregates (matchCount
//     / diffCount / etc.) update on the run record.' + finalizeRun
//     3-state union ('completed' | 'failed' | 'cancelled').
//   • IosVersionWatcher framing pinned: 'Detection layer — watches
//     for new iOS minor versions. Out of scope for V-179
//     implementation; the interface is the seam so a future
//     Apple-release-notes scraper / RSS watcher can drop in.';
//     today-fallback framing 'when Agent 1 notices a new iOS
//     version, founder triggers recapture manually'.
//   • IosVersionWatcher: 3 methods (getLastSeenVersion 'Stored
//     externally (filesystem JSON, key/value store) — implementations
//     supply persistence' + pollForTransition + recordTransitionHandled).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/interfaces.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W457.B packages/recapture-automation/src/interfaces.ts content parity', () => {
  const body = read(LIB);

  it("V-179 framing pinned: 'V-179 — recapture automation interfaces.'", () => {
    expect(body).toMatch(/\/\/ V-179 — recapture automation interfaces\./);
  });

  it('imports: 5 type-only from ./types (FingerprintComparison + IosVersionTransition + RecaptureRun + RecaptureStatus + TriggerRecaptureOpts)', () => {
    expect(body).toMatch(
      /import type \{\s*FingerprintComparison,\s*IosVersionTransition,\s*RecaptureRun,\s*RecaptureStatus,\s*TriggerRecaptureOpts,\s*\} from '\.\/types\.js';/,
    );
  });

  it("ListRunsOpts: 4 optional fields (archetypeId + status + limit 'Default 50, max 200' + cursor); ListRunsPage: {data + nextCursor}", () => {
    expect(body).toMatch(
      /export interface ListRunsOpts \{\s*\/\*\* Filter to a specific archetype\. Omit for all\. \*\/\s*archetypeId\?: string;[\s\S]*?status\?: RecaptureStatus;[\s\S]*?\/\*\* Page size\. Default 50, max 200\. \*\/\s*limit\?: number;[\s\S]*?cursor\?: string;\s*\}/,
    );
    expect(body).toMatch(
      /export interface ListRunsPage \{\s*data: readonly RecaptureRun\[\];\s*nextCursor: string \| null;\s*\}/,
    );
  });

  it("RecaptureService framing pinned: 'Top-level recapture orchestration service. Operators (founder + future automation) call triggerRecapture() when a version bump is detected; the service queues + runs the capture passes against the configured archetypes.'", () => {
    expect(body).toMatch(
      /\* Top-level recapture orchestration service\. Operators\s*\*\s*\(founder \+ future automation\) call `triggerRecapture\(\)` when\s*\*\s*a version bump is detected; the service queues \+ runs the\s*\*\s*capture passes against the configured archetypes\./,
    );
  });

  it("triggerRecapture framing pinned: 'Returns the run record with status queued; the worker picks it up + transitions through in_progress → completed / failed.'; signature returns Promise<RecaptureRun>", () => {
    expect(body).toMatch(
      /\* Queue a new recapture run\. Returns the run record with status\s*\*\s*`'queued'`; the worker picks it up \+ transitions through\s*\*\s*`'in_progress'` → `'completed'` \/ `'failed'`\./,
    );
    expect(body).toMatch(/triggerRecapture\(opts: TriggerRecaptureOpts\): Promise<RecaptureRun>;/);
  });

  it("getRun + listRuns + recordComparison + finalizeRun signatures; recordComparison framing pinned 'Append a per-surface comparison to a run-in-progress. Called by the capture worker as it walks each surface from file 121 + the cumulative-rig snapshot. Aggregates (matchCount / diffCount / etc.) update on the run record.'", () => {
    expect(body).toMatch(/getRun\(runId: string\): Promise<RecaptureRun \| null>;/);
    expect(body).toMatch(/listRuns\(opts\?: ListRunsOpts\): Promise<ListRunsPage>;/);
    expect(body).toMatch(
      /\* Append a per-surface comparison to a run-in-progress\. Called by\s*\*\s*the capture worker as it walks each surface from file 121 \+ the\s*\*\s*cumulative-rig snapshot\. Aggregates \(matchCount \/ diffCount \/\s*\*\s*etc\.\) update on the run record\./,
    );
    expect(body).toMatch(
      /recordComparison\(runId: string, comparison: FingerprintComparison\): Promise<RecaptureRun>;/,
    );
  });

  it("finalizeRun framing pinned: 'completed if the worker finished all surfaces; failed if it bailed mid-run. The run's aggregate counts reflect the per-surface comparisons accumulated so far.' + 3-state union ('completed'|'failed'|'cancelled')", () => {
    expect(body).toMatch(
      /\* Mark a run terminal\. `'completed'` if the worker finished all\s*\*\s*surfaces; `'failed'` if it bailed mid-run\. The run's aggregate\s*\*\s*counts reflect the per-surface comparisons accumulated so far\./,
    );
    expect(body).toMatch(
      /finalizeRun\(runId: string, status: 'completed' \| 'failed' \| 'cancelled'\): Promise<RecaptureRun>;/,
    );
  });

  it("IosVersionWatcher framing pinned: 'Detection layer — watches for new iOS minor versions. Out of scope for V-179 implementation; the interface is the seam so a future Apple-release-notes scraper / RSS watcher can drop in.' + today-fallback framing 'when Agent 1 notices a new iOS version, founder triggers recapture manually via RecaptureService.triggerRecapture().'", () => {
    expect(body).toMatch(
      /\* Detection layer — watches for new iOS minor versions\. Out of\s*\*\s*scope for V-179 implementation; the interface is the seam so a\s*\*\s*future Apple-release-notes scraper \/ RSS watcher can drop in\./,
    );
    expect(body).toMatch(
      /\* Today: when Agent 1 notices a new iOS version, founder triggers\s*\*\s*recapture manually via `RecaptureService\.triggerRecapture\(\)`\./,
    );
  });

  it("IosVersionWatcher: 3 methods (getLastSeenVersion framing 'Stored externally (filesystem JSON, key/value store) — implementations supply persistence.' + pollForTransition 'Implementations CAN call this from a cron (daily) or a manual trigger.' + recordTransitionHandled)", () => {
    expect(body).toMatch(
      /\*\s*Last seen iOS version\. Tracked across watcher invocations so\s*\*\s*the watcher can detect transitions\. Stored externally\s*\*\s*\(filesystem JSON, key\/value store\) — implementations supply\s*\*\s*persistence\./,
    );
    expect(body).toMatch(/getLastSeenVersion\(\): Promise<string \| null>;/);
    expect(body).toMatch(
      /\*\s*Check upstream \(Apple release notes, etc\.\) for a version\s*\*\s*newer than `getLastSeenVersion\(\)`\. Returns the transition if\s*\*\s*one is detected\. Implementations CAN call this from a cron\s*\*\s*\(daily\) or a manual trigger\./,
    );
    expect(body).toMatch(/pollForTransition\(\): Promise<IosVersionTransition \| null>;/);
    expect(body).toMatch(
      /recordTransitionHandled\(transition: IosVersionTransition\): Promise<void>;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
