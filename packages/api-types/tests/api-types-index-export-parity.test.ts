// W384.C — drift guard for packages/api-types/src/index.ts public
// surface. This is the package every SDK consumer + every internal
// app (apps/server, apps/marketing-site, apps/customer-dashboard,
// apps/admin-panel, apps/gui-client) imports from. Drift in the
// exported module surface silently breaks downstream tree-shaking
// or accidentally publishes server-internal shapes. Pins:
//
//   • Zod-source-of-truth + breaking-change framing in module
//     comment.
//   • 23 sub-module re-exports in canonical order: common /
//     problem / sessions / api-keys / accounts / usage / webhooks
//     / admin / auth / cli-authorize / incidents / profiles /
//     billing / crypto-orders / egress / livekit / agent-input-event
//     / agent-tab-ops / agent-models / agent-sessions / agent-intents /
//     recipes / archetypes.
//   • All 23 source files exist on disk (no dangling re-exports).
//   • The roster is complete — index.ts re-exports EXACTLY these
//     modules and no unpinned extras (count-parity guard).
//   • Server-internal-shapes-live-elsewhere framing pinned (load-
//     bearing convention: server-internal types stay in apps/server
//     /src/schemas/, NOT in packages/api-types).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'packages/api-types/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const EXPECTED_REEXPORTS = [
  'common',
  'problem',
  'sessions',
  'api-keys',
  'accounts',
  'usage',
  'webhooks',
  'admin',
  'auth',
  'cli-authorize',
  'incidents',
  'profiles',
  'billing',
  'crypto-orders',
  'egress',
  'livekit',
  'agent-input-event',
  'agent-tab-ops',
  'agent-models',
  'agent-sessions',
  'agent-intents',
  'recipes',
  'archetypes',
] as const;

describe('W384.C packages/api-types/src/index.ts public-surface content parity', () => {
  const body = read(INDEX);

  it('Zod-source-of-truth framing pinned (single source of truth for public API contracts)', () => {
    expect(body).toMatch(/Public API contracts for Driftstack\. Zod is the single source of truth/);
    expect(body).toMatch(/inferred TypeScript types are re-exported for SDK consumers/);
  });

  it('Versioning framing pinned: any breaking schema change = public-API breaking change', () => {
    expect(body).toMatch(
      /Versioning: any breaking change to a schema in this package is a breaking\s*\n?\s*\/\/\s*change to the public API/,
    );
  });

  it('Server-internal-shapes-live-elsewhere framing pinned (apps/server/src/schemas/ convention)', () => {
    expect(body).toMatch(
      /Server-internal shapes that aren't part of the\s*\n?\s*\/\/\s*public contract live in `apps\/server\/src\/schemas\/` instead/,
    );
  });

  it('23 sub-module re-exports pinned in canonical order', () => {
    let lastIdx = -1;
    for (const m of EXPECTED_REEXPORTS) {
      const expected = `export * from './${m}.js';`;
      const idx = body.indexOf(expected);
      expect(idx, `re-export out of order or missing: ${m}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('roster is complete — index.ts re-exports EXACTLY the pinned modules (no unpinned extras)', () => {
    const actual = Array.from(body.matchAll(/export \* from '\.\/([^']+)\.js';/g)).map((m) => m[1]);
    // Count-parity: a new `export * from './foo.js'` added without
    // updating EXPECTED_REEXPORTS would slip through the ordering loop
    // above (it only checks the pinned set is present + ordered, not
    // that nothing extra exists). This catches that drift.
    expect(actual).toEqual([...EXPECTED_REEXPORTS]);
  });

  it('23 source files exist on disk (no dangling re-exports)', () => {
    for (const m of EXPECTED_REEXPORTS) {
      const file = resolve(REPO_ROOT, `packages/api-types/src/${m}.ts`);
      expect(existsSync(file), `re-exported source file missing: ${m}.ts`).toBe(true);
    }
  });

  it('common.ts is the first re-export (foundational types — Account, Tier, scalar enums)', () => {
    const first = body.match(/export \* from '\.\/([^']+)\.js';/)?.[1];
    expect(first).toBe('common');
  });

  it('problem.ts is the second re-export (problem+json error envelope used by every endpoint)', () => {
    const matches = Array.from(body.matchAll(/export \* from '\.\/([^']+)\.js';/g)).map(
      (m) => m[1],
    );
    expect(matches[1]).toBe('problem');
  });

  it('uses .js extension on all re-exports (NodeNext ESM resolution)', () => {
    const reExports = Array.from(body.matchAll(/export \* from '([^']+)';/g)).map((m) => m[1]);
    expect(reExports.length).toBeGreaterThan(0);
    for (const e of reExports) {
      expect(e, `re-export missing .js extension: ${e}`).toMatch(/\.js$/);
    }
  });

  it('no inline type/const exports — index.ts is pure re-export aggregator', () => {
    expect(body).not.toMatch(/^export (const|function|class|interface|type) /m);
  });

  it('package.json exists at canonical path', () => {
    expect(existsSync(resolve(REPO_ROOT, 'packages/api-types/package.json'))).toBe(true);
  });
});
