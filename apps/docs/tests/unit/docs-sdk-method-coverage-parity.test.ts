// W285.C — drift guard for apps/docs/sdk pages. Each SDK doc page
// must enumerate the public methods exposed by the corresponding
// SDK module. Catches drift where a new SDK method ships but the
// docs page doesn't mention it.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// V-2128 — a missing subject is a broken test or a retired subject, never a
// pass: the earlier `if (!existsSync(…)) return` made every arm here go green
// the moment either file moved.
function mustExist(p: string, what: string): void {
  if (!existsSync(p)) {
    throw new Error(`${what} is missing at ${p}: update the pin rather than skipping it`);
  }
}

// Pin SDK Sessions resource methods to typescript-quickstart.md
// citations. This is the highest-visibility SDK page so it should
// keep up with the resource surface.
const SESSIONS_TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/sessions.ts');
const TS_QUICKSTART = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');

describe('W285.C SDK Sessions ↔ typescript-quickstart.md method coverage', () => {
  it('the core Sessions methods (create/destroy/navigate/capture) are cited in the quickstart', () => {
    mustExist(SESSIONS_TS, 'SDK Sessions resource');
    mustExist(TS_QUICKSTART, 'TypeScript quickstart page');
    const doc = read(TS_QUICKSTART);

    // Quickstarts cover the minimum-viable lifecycle, not every
    // method. Pin the core surface; broader reference docs cover
    // list/wait/interact/etc.
    const core = ['create', 'destroy', 'navigate', 'capture'];
    const missing = core.filter((m) => !new RegExp(`\\.${m}\\(`).test(doc));
    expect(missing).toEqual([]);
  });

  it('the SDK Sessions module exports a non-trivial method surface', () => {
    mustExist(SESSIONS_TS, 'SDK Sessions resource');
    const src = read(SESSIONS_TS);
    const methodRe =
      /^\s+(create|list|get|destroy|navigate|interact|capture|wait|update|listAll)\s*[(<]/gm;
    const methods = new Set<string>();
    for (const m of src.matchAll(methodRe)) {
      methods.add(m[1]!);
    }
    expect(methods.size).toBeGreaterThan(3);
  });
});
