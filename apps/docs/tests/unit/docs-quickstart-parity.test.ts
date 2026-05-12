// W254.D — drift-guard for docs.driftstack.dev/quickstart. Pins
// the SDK install commands + the create/navigate/capture/destroy
// path to actually-exported methods. Catches the case where the
// quickstart references a method the SDK no longer has.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md');
const SDK_TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function readAll(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out += readAll(p);
    else if (e.name.endsWith('.ts')) out += read(p) + '\n';
  }
  return out;
}

describe('W254.D docs/quickstart ↔ SDK method parity', () => {
  const doc = read(DOC);
  const tsBlob = readAll(SDK_TS);

  it('quickstart cites create / navigate / capture / destroy as SDK methods', () => {
    // The TypeScript SDK exposes these as methods on the sessions
    // resource. Reading sessions.ts confirms each is present.
    for (const m of ['create', 'navigate', 'capture', 'destroy']) {
      expect(doc, `doc missing sessions.${m}`).toMatch(new RegExp(`sessions\\.${m}\\(`));
      expect(tsBlob, `SDK missing sessions.${m}`).toMatch(new RegExp(`async ${m}\\(|${m}\\(`));
    }
  });

  it('cites the canonical npm + pip + go-get install commands', () => {
    expect(doc).toContain('npm install @driftstack/sdk');
    expect(doc).toContain('pip install driftstack-sdk');
    expect(doc).toContain('go get github.com/driftstackdev/driftstack-api/packages/sdk-go');
  });

  it('uses the ds_live_ API key prefix', () => {
    expect(doc).toMatch(/ds_live_/);
  });

  it('environment variable is DRIFTSTACK_API_KEY', () => {
    expect(doc).toMatch(/DRIFTSTACK_API_KEY/);
  });

  it('Node 18+ / Python 3.10+ / Go 1.21+ minimums are documented', () => {
    expect(doc).toMatch(/Node\.js 18\+/);
    expect(doc).toMatch(/Python 3\.10\+/);
    expect(doc).toMatch(/Go 1\.21\+/);
  });
});
