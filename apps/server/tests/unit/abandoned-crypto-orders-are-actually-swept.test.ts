// `sweepExpiredOrders` worked. Nothing ran it.
//
// Its only caller was the manual admin route (POST /v1/admin/crypto-orders/
// sweep), so an order abandoned before payment sat `pending` on the customer's
// billing page forever — listed under "recent orders", with no payment behind
// it and no route to a terminal state unless a staff member happened to fire a
// sweep by hand. Production carried exactly such a row: no payment_id, no
// pay_amount, a checkout opened and never paid.
//
// The defect was never in the sweep logic, which is why the existing
// crypto-orders tests all passed while the bug was live. It was the ABSENCE of
// a scheduler. So the load-bearing arm here is the bootstrap-wiring one: it
// greps the composition root for the register + enqueue pair, because a unit
// test of the job module would have passed just as happily in the broken world.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CRYPTO_ORDER_EXPIRY_BATCH_LIMIT,
  CRYPTO_ORDER_EXPIRY_OLDER_THAN_MS,
  CRYPTO_ORDER_EXPIRY_SWEEP_INTERVAL_MS,
  CRYPTO_ORDER_EXPIRY_SWEEP_JOB_TYPE,
  enqueueNextCryptoOrderExpirySweep,
  registerCryptoOrderExpirySweepJob,
} from '../../src/services/crypto-order-expiry-sweep-job.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const bootstrap = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');

const NOW = new Date('2026-08-23T00:00:00.000Z');

interface Enqueued {
  jobType: string;
  dedup: boolean;
  dedupAfterRunAt?: Date;
  runAt: Date;
}

function fakeScheduledJobs() {
  const enqueues: Enqueued[] = [];
  let handler: ((job: unknown) => Promise<void>) | undefined;
  const scheduledJobs = {
    register: (_jobType: string, h: (job: unknown) => Promise<void>) => {
      handler = h;
    },
    enqueue: (args: {
      jobType: string;
      dedupOnAccountAndType: boolean;
      dedupAfterRunAt?: Date;
      runAt: Date;
    }) => {
      enqueues.push({
        jobType: args.jobType,
        dedup: args.dedupOnAccountAndType,
        dedupAfterRunAt: args.dedupAfterRunAt,
        runAt: args.runAt,
      });
      return Promise.resolve({ enqueued: true });
    },
  };
  return { scheduledJobs, enqueues, invoke: () => handler!({ runAt: NOW }) };
}

describe('abandoned pending crypto orders are actually swept', () => {
  it('CRITICAL bootstrap REGISTERS and ENQUEUES the sweep. The sweep function always existed and always worked; having no scheduler is what left orders pending forever, and no test of the sweep itself can see that.', () => {
    expect(bootstrap).toMatch(/registerCryptoOrderExpirySweepJob\(\{/);
    expect(bootstrap).toMatch(/await enqueueNextCryptoOrderExpirySweep\(\{ scheduledJobs/);
    // Registering a handler with nothing ever enqueued is the same dead chain
    // in a different shape, so both halves are pinned, not just the import.
    expect(bootstrap).toMatch(
      /import \{\s*\n?\s*registerCryptoOrderExpirySweepJob,\s*\n?\s*enqueueNextCryptoOrderExpirySweep,\s*\n?\s*\} from '\.\.\/services\/crypto-order-expiry-sweep-job\.js';/,
    );
  });

  it('sweeps at the 24h window the admin route and the age histogram already use', async () => {
    const f = fakeScheduledJobs();
    const sweepExpiredOrders = vi.fn().mockResolvedValue({ expired: 3, capped: false });
    registerCryptoOrderExpirySweepJob({
      scheduledJobs: f.scheduledJobs as never,
      service: { sweepExpiredOrders },
      nowFn: () => NOW.getTime(),
    });
    await f.invoke();

    expect(sweepExpiredOrders).toHaveBeenCalledWith({
      olderThanMs: CRYPTO_ORDER_EXPIRY_OLDER_THAN_MS,
      limit: CRYPTO_ORDER_EXPIRY_BATCH_LIMIT,
    });
    // 24h exactly — anything shorter starts expiring orders operators still
    // expect to be live.
    expect(CRYPTO_ORDER_EXPIRY_OLDER_THAN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('bootstrap enqueue dedups all pending; the re-arm dedups only future successors', async () => {
    const f = fakeScheduledJobs();
    await enqueueNextCryptoOrderExpirySweep({ scheduledJobs: f.scheduledJobs as never });
    expect(f.enqueues.at(-1)).toMatchObject({
      jobType: CRYPTO_ORDER_EXPIRY_SWEEP_JOB_TYPE,
      dedup: true,
    });

    const sweepExpiredOrders = vi.fn().mockResolvedValue({ expired: 0, capped: false });
    registerCryptoOrderExpirySweepJob({
      scheduledJobs: f.scheduledJobs as never,
      service: { sweepExpiredOrders },
      nowFn: () => NOW.getTime(),
    });
    await f.invoke();

    const reArm = f.enqueues.at(-1)!;
    expect(reArm.dedup).toBe(true);
    expect(reArm.dedupAfterRunAt).toEqual(NOW);
    expect(reArm.runAt).toEqual(new Date(NOW.getTime() + CRYPTO_ORDER_EXPIRY_SWEEP_INTERVAL_MS));
  });

  it('a failing tick re-arms exactly once, so the chain neither dies nor fans out', async () => {
    const f = fakeScheduledJobs();
    // Re-throwing would let the poller retry the job while this also re-armed →
    // duplicate parallel chains. Not re-arming would kill the chain until a
    // process restart, which is the failure the whole module exists to prevent.
    const sweepExpiredOrders = vi.fn().mockRejectedValue(new Error('db down'));
    registerCryptoOrderExpirySweepJob({
      scheduledJobs: f.scheduledJobs as never,
      service: { sweepExpiredOrders },
      nowFn: () => NOW.getTime(),
    });

    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({ jobType: CRYPTO_ORDER_EXPIRY_SWEEP_JOB_TYPE });
  });
});
