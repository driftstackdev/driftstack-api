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
