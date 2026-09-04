// W254.D — drift-guard for docs.driftstack.io/quickstart. Pins
// the SDK install commands + the create/navigate/capture/destroy
// path to actually-exported methods. Catches the case where the
// quickstart references a method the SDK no longer has.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureResponseSchema } from '@driftstack/api-types';

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

  it('Node 18+ / Python 3.10+ / Go 1.22+ minimums are documented (2026-06-24: go.mod declares go 1.22, so the Go floor is 1.22+, was a stale 1.21+)', () => {
    expect(doc).toMatch(/Node\.js 18\+/);
    expect(doc).toMatch(/Python 3\.10\+/);
    expect(doc).toMatch(/Go 1\.22\+/);
    // The stale Go 1.21+ floor must NOT return.
    expect(doc).not.toMatch(/Go 1\.21\+/);
  });

  it('W564: "what happened" documents the real capture-response shape + base64 decode', () => {
    // Source-derived: every CaptureResponseSchema field must appear in the
    // doc, so a schema change forces the quickstart to keep up.
    for (const field of Object.keys(CaptureResponseSchema.shape)) {
      expect(doc, `quickstart must document capture field '${field}'`).toContain(field);
    }
    // The base64-decode hint (the gotcha the shape note exists to prevent).
    expect(doc).toContain("Buffer.from(shot.data, 'base64')");
    expect(doc).toMatch(/base64-encoded/);
  });

  it('pins paid API access, Free desktop onboarding and actionable downgrade recovery', () => {
    expect(doc).toMatch(/Any paid Driftstack tier \(Manual, API, or Enterprise\)/);
    expect(doc).toMatch(/Free does not mint\s*\n?customer API keys/);
    expect(doc).toMatch(
      /They become usable again after an\s*\n?upgrade unless they were revoked or expired/,
    );
    expect(doc).toMatch(/The "apiAccess" feature is not available on the "free" tier/);
  });
});
