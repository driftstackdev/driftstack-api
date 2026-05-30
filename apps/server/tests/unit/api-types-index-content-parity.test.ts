// W432.A — drift guard for packages/api-types/src/index.ts.
// Public API contracts barrel. Drift here either drops a module
// (consumer's `import { X } from '@driftstack/api-types'` breaks at
// build time across server + SDK + GUI + dashboard) or accidentally
// publishes a server-internal type (the public contract was meant
// to live in apps/server/src/schemas/ per L-001).
//
//   • Framing pinned: Zod single source of truth; inferred TS types
//     re-exported for SDK consumers.
//   • Versioning rationale pinned: breaking-schema-change == public
//     API break; server-internal shapes live elsewhere.
//   • Re-exports pinned: 14 module barrel (common + problem +
//     sessions + api-keys + accounts + usage + webhooks + admin +
//     auth + cli-authorize + incidents + profiles + billing +
//     crypto-orders).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W432.A packages/api-types/src/index.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: Public API contracts for Driftstack; Zod single source of truth; inferred TS types re-exported for SDK consumers', () => {
    expect(body).toMatch(
      /\/\/ Public API contracts for Driftstack\. Zod is the single source of truth;\s*\n?\s*\/\/ inferred TypeScript types are re-exported for SDK consumers\./,
    );
  });

  it('Versioning rationale pinned: breaking schema change == breaking public API; server-internal shapes live in apps/server/src/schemas/ instead (L-001 boundary)', () => {
    expect(body).toMatch(
      /\/\/ Versioning: any breaking change to a schema in this package is a breaking\s*\n?\s*\/\/ change to the public API\. Server-internal shapes that aren't part of the\s*\n?\s*\/\/ public contract live in `apps\/server\/src\/schemas\/` instead\./,
    );
  });

  it('16-module barrel pinned (common + problem + sessions + api-keys + accounts + usage + webhooks + admin + auth + cli-authorize + incidents + profiles + billing + crypto-orders + egress + livekit). EG-API-1.1 added egress; v2-#7 added livekit per agent-sessions live-stream signaling.', () => {
    for (const mod of [
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
    ] as const) {
      expect(body).toMatch(new RegExp(`export \\* from '\\.\\/${mod}\\.js';`));
    }
  });

  it('Barrel is re-exports only (no inline declarations); 20 export-star lines (one per module — agent-input-event + agent-models + agent-sessions + agent-intents added with the api-types growth)', () => {
    const exportStarMatches = body.match(/^export \* from '\.\/[a-z-]+\.js';$/gm);
    expect(exportStarMatches).not.toBeNull();
    expect((exportStarMatches ?? []).length).toBe(20);
  });

  it('agent-models barrel export pinned (per-session model picker registry — #15 / 6.c)', () => {
    expect(body).toMatch(/export \* from '\.\/agent-models\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
