import { describe, expect, it } from 'vitest';
import {
  MockIosVersionWatcher,
  MockRecaptureService,
  type FingerprintComparison,
  type IosVersionTransition,
} from '../src/index.js';

const BASELINE = { iosVersion: '18.7', safariVersion: '26.4' };
const TARGET = { iosVersion: '18.8', safariVersion: '26.4' };

describe('MockRecaptureService', () => {
  it('triggerRecapture returns a queued run with stable id shape', async () => {
    const svc = new MockRecaptureService();
    const run = await svc.triggerRecapture({
      trigger: 'ios_version_bump',
      archetypeId: 'iphone16pro_ios18_7_safari26_4',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    });
    expect(run.id).toMatch(/^rcap_\d{8}$/);
    expect(run.status).toBe('queued');
    expect(run.comparisons).toEqual([]);
    expect(run.matchCount).toBe(0);
    expect(run.startedAtMs).toBeNull();
    expect(run.completedAtMs).toBeNull();
  });

  it('recordComparison transitions queued → in_progress + accumulates counts', async () => {
    const svc = new MockRecaptureService();
    const run = await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'iphone16pro_ios18_7_safari26_4',
      baselineVersion: BASELINE,
      targetVersion: BASELINE,
    });

    const matchComp: FingerprintComparison = {
      surfaceId: 'webgl.G3.renderer',
      outcome: 'match',
      baselineValue: 'Apple GPU',
      recapturedValue: 'Apple GPU',
      notes: null,
    };
    const diffComp: FingerprintComparison = {
      surfaceId: 'navigator.N8.userAgent',
      outcome: 'diff',
      baselineValue: 'Mozilla/5.0 ... 18.7',
      recapturedValue: 'Mozilla/5.0 ... 18.8',
      notes: 'iOS version string updated',
    };

    let updated = await svc.recordComparison(run.id, matchComp);
    expect(updated.status).toBe('in_progress');
    expect(updated.startedAtMs).not.toBeNull();
    expect(updated.matchCount).toBe(1);

    updated = await svc.recordComparison(run.id, diffComp);
    expect(updated.diffCount).toBe(1);
    expect(updated.matchCount).toBe(1);
    expect(updated.comparisons).toHaveLength(2);
  });

  it('finalizeRun marks completedAtMs + sets status', async () => {
    const svc = new MockRecaptureService();
    const run = await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'a',
      baselineVersion: BASELINE,
      targetVersion: BASELINE,
    });
    const finalized = await svc.finalizeRun(run.id, 'completed');
    expect(finalized.status).toBe('completed');
    expect(finalized.completedAtMs).not.toBeNull();
  });

  it('getRun returns null for unknown id', async () => {
    const svc = new MockRecaptureService();
    expect(await svc.getRun('rcap_nonexistent')).toBeNull();
  });

  it('listRuns filters by archetypeId + status', async () => {
    const svc = new MockRecaptureService();
    const a = await svc.triggerRecapture({
      trigger: 'ios_version_bump',
      archetypeId: 'arch_a',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    });
    await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'arch_b',
      baselineVersion: BASELINE,
      targetVersion: BASELINE,
    });
    await svc.finalizeRun(a.id, 'completed');

    const all = await svc.listRuns();
    expect(all.data).toHaveLength(2);

    const archA = await svc.listRuns({ archetypeId: 'arch_a' });
    expect(archA.data).toHaveLength(1);
    expect(archA.data[0]?.id).toBe(a.id);

    const completed = await svc.listRuns({ status: 'completed' });
    expect(completed.data).toHaveLength(1);
    expect(completed.data[0]?.id).toBe(a.id);
  });

  it('listRuns paginates with cursor', async () => {
    const svc = new MockRecaptureService();
    for (let i = 0; i < 5; i += 1) {
      await svc.triggerRecapture({
        trigger: 'manual_request',
        archetypeId: `arch_${i.toString()}`,
        baselineVersion: BASELINE,
        targetVersion: BASELINE,
      });
    }
    const page1 = await svc.listRuns({ limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.listRuns({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.data).toHaveLength(2);
    const ids1 = new Set(page1.data.map((r) => r.id));
    const ids2 = new Set(page2.data.map((r) => r.id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it('clamps a negative limit to a correct page + correct (null-when-done) cursor', async () => {
    const svc = new MockRecaptureService();
    await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'arch_0',
      baselineVersion: BASELINE,
      targetVersion: BASELINE,
    });
    const page = await svc.listRuns({ limit: -1 });
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('terminates pagination when the cursor row is no longer in the filtered set (no infinite loop)', async () => {
    // Regression: when the cursor's row drops out of the filtered set (e.g.
    // its status changed between pages so it no longer matches a status
    // filter, or it was deleted), findIndex returned -1 and the unsliced list
    // was returned WITH a fresh nextCursor → the client got page 1 again plus
    // a cursor it already held, looping forever. The fix terminates: empty
    // data + null nextCursor.
    const svc = new MockRecaptureService();
    // Create enough runs that a single page wouldn't exhaust the list (so the
    // bug would have emitted a non-null nextCursor on the bogus-cursor call).
    for (let i = 0; i < 5; i += 1) {
      await svc.triggerRecapture({
        trigger: 'manual_request',
        archetypeId: `arch_${i.toString()}`,
        baselineVersion: BASELINE,
        targetVersion: BASELINE,
      });
    }
    const page = await svc.listRuns({ limit: 2, cursor: 'rcap_99999999' });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('terminates pagination when the cursor row dropped out of a status filter mid-walk', async () => {
    const svc = new MockRecaptureService();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await svc.triggerRecapture({
        trigger: 'manual_request',
        archetypeId: `arch_${i.toString()}`,
        baselineVersion: BASELINE,
        targetVersion: BASELINE,
      });
      ids.push(r.id);
    }
    // All 4 are 'queued'. Page 1 of the queued filter, limit 2.
    const page1 = await svc.listRuns({ status: 'queued', limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const cursor = page1.nextCursor!;
    // The cursor row now finalizes → it leaves the 'queued' filtered set.
    await svc.finalizeRun(cursor, 'completed');
    // Resuming the queued walk from a cursor no longer in the queued set must
    // terminate, not loop.
    const page2 = await svc.listRuns({ status: 'queued', limit: 2, cursor });
    expect(page2.nextCursor).toBeNull();
    expect(page2.data).toEqual([]);
  });
});

describe('MockRecaptureService — triggerRecapture idempotency (Fix 2, 2026-07-01 audit)', () => {
  it('two concurrent triggerRecapture calls with identical archetypeId+targetVersion produce only ONE run', async () => {
    const svc = new MockRecaptureService();
    const opts = {
      trigger: 'ios_version_bump' as const,
      archetypeId: 'iphone16pro_ios18_7_safari26_4',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    };
    const [first, second] = await Promise.all([
      svc.triggerRecapture(opts),
      svc.triggerRecapture(opts),
    ]);
    expect(second.id).toBe(first.id);
    const all = await svc.listRuns();
    expect(all.data).toHaveLength(1);
  });

  it('a second sequential trigger for the same target while the first is still queued returns the SAME existing run (no duplicate insert)', async () => {
    const svc = new MockRecaptureService();
    const opts = {
      trigger: 'manual_request' as const,
      archetypeId: 'arch1',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    };
    const first = await svc.triggerRecapture(opts);
    const second = await svc.triggerRecapture(opts);
    expect(second.id).toBe(first.id);
    expect((await svc.listRuns()).data).toHaveLength(1);
  });

  it('a fresh trigger for the same target AFTER the prior run completed is NOT deduped — a new run is queued', async () => {
    const svc = new MockRecaptureService();
    const opts = {
      trigger: 'manual_request' as const,
      archetypeId: 'arch1',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    };
    const first = await svc.triggerRecapture(opts);
    await svc.finalizeRun(first.id, 'completed');
    const second = await svc.triggerRecapture(opts);
    expect(second.id).not.toBe(first.id);
    expect((await svc.listRuns()).data).toHaveLength(2);
  });

  it('no-regression: different archetypeId/targetVersion combos each get their own independent run', async () => {
    const svc = new MockRecaptureService();
    const a = await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'arch_a',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    });
    const b = await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'arch_b',
      baselineVersion: BASELINE,
      targetVersion: TARGET,
    });
    const c = await svc.triggerRecapture({
      trigger: 'manual_request',
      archetypeId: 'arch_a',
      baselineVersion: BASELINE,
      targetVersion: { iosVersion: '19.0', safariVersion: '27.0' },
    });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect((await svc.listRuns()).data).toHaveLength(3);
  });
});

describe('MockRecaptureService — runs map cap (Fix 5, 2026-07-01 audit)', () => {
  it('exceeding maxEntries evicts the oldest run (insertion order)', async () => {
    const svc = new MockRecaptureService({}, 3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await svc.triggerRecapture({
        trigger: 'manual_request',
        archetypeId: `arch_${i.toString()}`,
        baselineVersion: BASELINE,
        targetVersion: TARGET,
      });
      ids.push(r.id);
    }
    const all = await svc.listRuns({ limit: 200 });
    expect(all.data).toHaveLength(3);
    // Oldest (first-inserted) run was evicted.
    expect(all.data.some((r) => r.id === ids[0])).toBe(false);
    for (const id of ids.slice(1)) {
      expect(all.data.some((r) => r.id === id)).toBe(true);
    }
  });

  it('no-regression: usage well under the (default) cap keeps every run', async () => {
    const svc = new MockRecaptureService();
    for (let i = 0; i < 5; i += 1) {
      await svc.triggerRecapture({
        trigger: 'manual_request',
        archetypeId: `arch_${i.toString()}`,
        baselineVersion: BASELINE,
        targetVersion: TARGET,
      });
    }
    const all = await svc.listRuns({ limit: 200 });
    expect(all.data).toHaveLength(5);
  });
});

describe('MockIosVersionWatcher', () => {
  it('returns null when no pending transitions', async () => {
    const w = new MockIosVersionWatcher();
    expect(await w.pollForTransition()).toBeNull();
    expect(await w.getLastSeenVersion()).toBeNull();
  });

  it('surfaces a queued transition then transitions to none', async () => {
    const t: IosVersionTransition = {
      fromIosVersion: '18.7',
      toIosVersion: '18.8',
      detectedAtMs: 1700000000000,
      source: 'apple-release-notes',
    };
    const w = new MockIosVersionWatcher({
      initialLastSeen: '18.7',
      pendingTransitions: [t],
    });
    const detected = await w.pollForTransition();
    expect(detected).toEqual(t);
    expect(await w.pollForTransition()).toBeNull();
  });

  it('recordTransitionHandled updates lastSeen', async () => {
    const w = new MockIosVersionWatcher({ initialLastSeen: '18.7' });
    const t: IosVersionTransition = {
      fromIosVersion: '18.7',
      toIosVersion: '18.8',
      detectedAtMs: 0,
      source: 'manual',
    };
    await w.recordTransitionHandled(t);
    expect(await w.getLastSeenVersion()).toBe('18.8');
  });
});
