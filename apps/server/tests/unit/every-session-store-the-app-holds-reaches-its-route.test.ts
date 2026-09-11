// A store the app HOLDS but never HANDS OVER is a feature that is fully built and
// entirely dead.
//
// `bootstrap` constructs one `SessionCaptureStore` and gives it to two collaborators:
// the agent executor (which WRITES a screenshot and mints a captureId) and the app deps
// (so the route can READ it). The app declared the dep, the route accepted the option,
// the executor minted real ids, and the GUI asked for them — but `buildApp` never
// forwarded it, so `/v1/agent-sessions/:id/captures/:captureId` answered 404 for every
// capture that existed. The owner reported it as "no way to view captured screenshots".
//
// ⚠️ Why the existing tests could not catch it: every route test registers
// `registerAgentSessionsRoutes` DIRECTLY and passes the store itself (see
// `tests/integration/a-network-log-ring-is-bounded-and-owner-scoped.test.ts:322`). That
// proves the ROUTE works given a store. It cannot observe whether the APP supplies one —
// the test does the app's job for it, which is precisely the gap.
//
// So this guard asserts the WIRING, derived on both sides rather than hand-listed: for
// every `*Store` the app deps declare AND the route options accept, the
// `registerAgentSessionsRoutes(...)` call in `app.ts` must forward it. A new store added
// to both types and left unwired reds this test on the commit that adds it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const APP = resolve(REPO, 'apps/server/src/lib/app.ts');
const ROUTES = resolve(REPO, 'apps/server/src/routes/agent-sessions.ts');

const read = (p: string): string => readFileSync(p, 'utf8');

/** Optional `name?: SomethingStore;` declarations in a source file. */
function declaredStores(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s{2}(\w+)\?:\s*\w*Store;$/gm)) {
    const name = m[1];
    // The pattern has exactly one capture group, so a match always carries it.
    // Throwing — rather than skipping an undefined — keeps a later edit to the
    // regex from silently shrinking the population this guard derives, which
    // would make it pass by checking nothing.
    if (name === undefined) throw new Error(`matched without a capture group: ${m[0]}`);
    out.add(name);
  }
  return out;
}

/** The argument list of the `registerAgentSessionsRoutes(` call in app.ts. */
function registerCall(src: string): string {
  const start = src.indexOf('registerAgentSessionsRoutes(');
  expect(start, 'app.ts must call registerAgentSessionsRoutes').toBeGreaterThan(-1);
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i);
}

describe('every session store the app holds reaches its route', () => {
  it('CRITICAL every *Store the app deps declare AND the route accepts is forwarded in the registerAgentSessionsRoutes call. A store held but not handed over is a built feature that answers 404 — how the screenshot thumbnail shipped dead', () => {
    const appSrc = read(APP);
    const shared = [...declaredStores(appSrc)].filter((n) => declaredStores(read(ROUTES)).has(n));
    const call = registerCall(appSrc);
    const missing = shared.filter((n) => !new RegExp(`\\{\\s*${n}\\s*:`).test(call));
    expect(
      missing,
      `declared on BOTH sides but never forwarded to the route:\n  ${missing.join('\n  ')}\n` +
        'add `...(deps.<name> !== undefined ? { <name>: deps.<name> } : {})` to the ' +
        'registerAgentSessionsRoutes options in apps/server/src/lib/app.ts',
    ).toEqual([]);
  });

  it('CRITICAL the screenshot store specifically — the one this test was written for', () => {
    expect(registerCall(read(APP))).toMatch(/\{\s*sessionCaptureStore\s*:/);
  });

  it('VACUITY CONTROL — the derivation found a real, non-trivial population on both sides, so an empty intersection cannot pass silently', () => {
    const app = declaredStores(read(APP));
    const routes = declaredStores(read(ROUTES));
    const shared = [...app].filter((n) => routes.has(n));
    expect(app.size).toBeGreaterThanOrEqual(4);
    expect(routes.size).toBeGreaterThanOrEqual(4);
    expect(shared.length).toBeGreaterThanOrEqual(4);
    expect(shared).toContain('sessionCaptureStore');
  });
});
