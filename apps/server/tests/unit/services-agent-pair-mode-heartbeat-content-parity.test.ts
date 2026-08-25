// Drift guard for apps/server/src/services/agent-pair-mode-heartbeat.ts.
// Pins the Arc 4 Wave 2.B sub-slice 8.13b pair-mode heartbeat tracker —
// PairModeHeartbeatTracker interface + InMemory impl + 30s default TTL +
// oldest-first sort contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-pair-mode-heartbeat.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-pair-mode-heartbeat content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 4 Wave 2.B sub-slice 8.13b module-level framing pinned: 'pair-mode heartbeat tracker. Pure data structure that maps sessionId → lastHeartbeatAt and exposes findStaleSessions(now, ttlMs) so a sweep service can fire the heartbeat-timeout state-machine transition (sub-slice 8.13) for each stale session.' — pinned so the 8.13b anchor + the pure-data-structure framing + the 8.13 state-machine cross-reference stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 4 Wave 2\.B sub-slice 8\.13b \(v2-#8\) — pair-mode heartbeat tracker\./,
    );
    expect(body).toMatch(
      /\/\/ Pure data structure that maps `sessionId → lastHeartbeatAt` and\s*\/\/ exposes `findStaleSessions\(now, ttlMs\)` so a sweep service can\s*\/\/ fire the `heartbeat-timeout` state-machine transition \(sub-slice\s*\/\/ 8\.13\) for each stale session\./,
    );
  });

  it("Sweep-service-not-wired-here framing pinned: 'The sweep service itself is intentionally not wired here — that follow-up adds a scheduled-job entry that scans this tracker every 5s and fires the transition + audit emit (sub-slice 8.13c). This slice ships the tracker primitive in isolation so its semantics are pinned by unit tests before any cron-driver couples to it.' — pinned so the 8.13c sweep cross-reference + the 5s-scan cadence + the deliberate-isolation rationale stay documented", () => {
    expect(body).toMatch(
      /\/\/ The sweep service itself is intentionally not wired here — that\s*\/\/ follow-up adds a scheduled-job entry that scans this tracker every\s*\/\/ 5s and fires the transition \+ audit emit \(sub-slice 8\.13c\)\. This\s*\/\/ slice ships the tracker primitive in isolation so its semantics\s*\/\/ are pinned by unit tests before any cron-driver couples to it\./,
    );
  });

  it("Single-replica + future-redis-swap framing pinned: 'Single-replica today. A future redis-backed swap can replace the in-memory Map with redis-hash storage; the public interface stays the same so the swap is invisible to callers.' — pinned so the v1.0-single-replica posture + invisible-redis-swap contract survive", () => {
    expect(body).toMatch(
      /\/\/ Single-replica today\. A future redis-backed swap can replace the\s*\/\/ in-memory Map with redis-hash storage; the public interface stays\s*\/\/ the same so the swap is invisible to callers\./,
    );
  });

  it('PairModeHeartbeatTracker 4-method interface pinned: recordHeartbeat + forget + findStaleSessions + getLastHeartbeatAt (test-only). Drift to dropping forget would let the tracker accumulate stale entries on session-close + handback-complete (the comment explicitly names that case)', () => {
    expect(body).toMatch(/export interface PairModeHeartbeatTracker \{/);
    expect(body).toMatch(/recordHeartbeat\(args: \{ sessionId: string; at: Date \}\): void;/);
    expect(body).toMatch(/forget\(sessionId: string\): void;/);
    expect(body).toMatch(
      /findStaleSessions\(args: \{ now: Date; ttlMs: number \}\): readonly string\[\];/,
    );
    expect(body).toMatch(/getLastHeartbeatAt\(sessionId: string\): Date \| null;/);
  });

  it("findStaleSessions sort-order framing pinned: 'Returns sessions sorted by lastHeartbeatAt ascending (oldest first) so the sweep handles the most-stuck sessions first if it has to truncate.' — pinned so the oldest-first contract stays documented (drift to a different sort order would silently change which sessions get auto-handback first when the sweep has to skip some)", () => {
    expect(body).toMatch(
      /Returns sessions sorted by lastHeartbeatAt ascending \(oldest\s*\*\s+first\) so the sweep handles the most-stuck sessions first if it\s*\*\s+has to truncate\./,
    );
  });

  it("forget()-on-session-close framing pinned: 'Forget a session's heartbeat (called on session close or explicit handback-complete so the tracker doesn't accumulate stale entries indefinitely).' — pinned so the cleanup-on-close + cleanup-on-handback-complete contract stays documented", () => {
    expect(body).toMatch(
      /Forget a session's heartbeat \(called on session close or\s*\*\s+explicit handback-complete so the tracker doesn't accumulate\s*\*\s+stale entries indefinitely\)\./,
    );
  });

  it('InMemoryPairModeHeartbeatTracker findStaleSessions() sort-then-map pattern pinned: collect (id, ts) tuples below cutoff, sort by ts ascending, map to ids. Drift to a different sort key OR dropping the sort would violate the oldest-first contract', () => {
    expect(body).toMatch(
      /const cutoff = args\.now\.getTime\(\) - args\.ttlMs;\s*const stale: Array<\{ id: string; ts: number \}> = \[\];\s*for \(const \[sessionId, last\] of this\.entries\) \{\s*const ts = last\.getTime\(\);\s*if \(ts < cutoff\) stale\.push\(\{ id: sessionId, ts \}\);\s*\}\s*stale\.sort\(\(a, b\) => a\.ts - b\.ts\);\s*return stale\.map\(\(s\) => s\.id\);/,
    );
  });

  it("PAIR_MODE_HEARTBEAT_TTL_MS = 30_000 pinned: 'Default heartbeat-timeout window per founder verdict on the Wave 2.A 8.13 transition (30 seconds). Exported as a constant so the sweep service + docs + state-machine commentary stay aligned.' — pinned so the 30s window + cross-source single-source-of-truth contract survives. Drift would diverge from the state-machine's heartbeat-timeout transition framing", () => {
    expect(body).toMatch(
      /\/\*\* Default heartbeat-timeout window per founder verdict on the\s*\*\s+Wave 2\.A 8\.13 transition \(30 seconds\)\. Exported as a constant so\s*\*\s+the sweep service \+ docs \+ state-machine commentary stay aligned\. \*\/\s*export const PAIR_MODE_HEARTBEAT_TTL_MS = 30_000;/,
    );
  });
});
