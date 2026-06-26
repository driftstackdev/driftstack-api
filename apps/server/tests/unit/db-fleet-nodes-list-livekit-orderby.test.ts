/* eslint-disable @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return,
   @typescript-eslint/no-unsafe-argument */
// Lint disables apply ONLY to the dynamic Proxy over Drizzle's query builder
// below — it intercepts the builder chain to capture rendered SQL without a
// live connection, which is inherently `any`-typed (Drizzle's per-stage builder
// generics are not statically wrappable). The assertions themselves are typed.
//
// Region-blind dispatch regression (2026-06-26) —
// DrizzleFleetNodesRepo.listWithLivekitNearest(null) must NOT render
// `ORDER BY false ...`. PostgreSQL REJECTS `ORDER BY <boolean-literal>` at
// execution, so the prior `desc(... : sql`false`)` form threw on every
// region-blind dispatch (the DEFAULT for accounts with no region) →
// sessionAssign never reached the fleet box → the customer browser never
// opened. This renders the EXACT SQL the repo builds (no live Postgres needed)
// and asserts:
//   - region-blind (null/'') → pure recency, NO `order by false`/`true`.
//   - region-bound          → region-match rows first, then recency (unchanged).
//
// It drives the REAL repo method (not a re-implementation) by injecting a
// Database whose drizzle `select()` is intercepted so `.orderBy(...)` captures
// the built query's SQL via `.toSQL()` instead of hitting the wire.

import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { Database } from '../../src/db/client.js';
import type * as schema from '../../src/db/schema.js';

/** A drizzle db that never touches the wire: it builds the query for real, then
 *  `.orderBy(...)` captures the rendered SQL and short-circuits to `[]` (so the
 *  repo's `.map(rowToDetail)` runs over an empty set). */
function renderingDb(capture: (sql: string) => void): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
} {
  // No connection is opened — we only ever call `.toSQL()`, never `.execute()`.
  const client = postgres('postgres://x:x@127.0.0.1:1/x', {
    max: 1,
    connect_timeout: 1,
    idle_timeout: 1,
  });
  const realDb = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;

  // Wrap a query-builder stage so EVERY chained call (`.from`, `.where`, …)
  // returns a re-wrapped stage (drizzle returns fresh/this builders per call),
  // and `.orderBy(...)` captures the rendered SQL + short-circuits to `[]`
  // (a thenable) so nothing is sent over the wire.
  const wrapStage = (stage: any): any =>
    new Proxy(stage, {
      get(s, key, recv) {
        if (key === 'orderBy') {
          return (...obArgs: unknown[]) => {
            const built = s.orderBy(...obArgs);
            capture(built.toSQL().sql);
            return Promise.resolve([]);
          };
        }
        const v = Reflect.get(s, key, recv);
        if (typeof v === 'function') {
          return (...args: unknown[]) => {
            const out = v.apply(s, args);
            // Re-wrap chainable builder stages (objects with an orderBy method).
            return out && typeof out === 'object' && typeof out.orderBy === 'function'
              ? wrapStage(out)
              : out;
          };
        }
        return v;
      },
    });

  const proxied = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        // The repo calls `.select()` with no projection arg.
        return () => wrapStage(target.select());
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { db: proxied, close: () => client.end({ timeout: 1 }).catch(() => undefined) };
}

describe('DrizzleFleetNodesRepo.listWithLivekitNearest — ORDER BY rendering (no live Postgres)', () => {
  it('region-blind (null) degrades to pure recency — never `order by false`', async () => {
    let rendered = '';
    const { db, close } = renderingDb((s) => {
      rendered = s;
    });
    try {
      const repo = new DrizzleFleetNodesRepo({ db } as unknown as Database);
      await repo.listWithLivekitNearest(null);
    } finally {
      await close();
    }
    const lower = rendered.toLowerCase();
    // The Postgres-illegal forms that the old code produced:
    expect(lower).not.toContain('order by false');
    expect(lower).not.toContain('order by true');
    // Degrades to recency-only.
    expect(lower).toContain('order by "fleet_nodes"."livekit_registered_at" desc');
    expect(lower).not.toContain('"fleet_nodes"."region"');
  });

  it("region-blind (empty string '') is treated as region-blind too", async () => {
    let rendered = '';
    const { db, close } = renderingDb((s) => {
      rendered = s;
    });
    try {
      const repo = new DrizzleFleetNodesRepo({ db } as unknown as Database);
      await repo.listWithLivekitNearest('');
    } finally {
      await close();
    }
    const lower = rendered.toLowerCase();
    expect(lower).not.toContain('order by false');
    expect(lower).toContain('order by "fleet_nodes"."livekit_registered_at" desc');
  });

  it('region-bound keeps region-match rows first, then recency (unchanged behaviour)', async () => {
    let rendered = '';
    const { db, close } = renderingDb((s) => {
      rendered = s;
    });
    try {
      const repo = new DrizzleFleetNodesRepo({ db } as unknown as Database);
      await repo.listWithLivekitNearest('eu');
    } finally {
      await close();
    }
    const lower = rendered.toLowerCase();
    expect(lower).not.toContain('order by false');
    // region match first, then recency.
    expect(lower).toContain(
      'order by "fleet_nodes"."region" = $1 desc, "fleet_nodes"."livekit_registered_at" desc',
    );
  });
});
