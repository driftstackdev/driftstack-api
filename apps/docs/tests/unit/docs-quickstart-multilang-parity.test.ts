// W260.D — drift-guard for the multi-language /quickstart page. Pins:
// 1. Go install path matches go.mod module name.
// 2. Per-tier concurrent-cap numbers in the "What happened" copy match
//    TIER_CONCURRENT_SESSION_LIMITS exactly.
// 3. ds_live_ key prefix matches the schema.
// 4. Sessions method names cited exist on the live SDK shapes.
// 5. Cross-link targets exist.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W260.D docs/quickstart (multi-lang) ↔ live surface parity', () => {
  const doc = read(DOC);

  it('Go install path matches sdk-go go.mod module name', () => {
    const goMod = read(resolve(REPO_ROOT, 'packages/sdk-go/go.mod'));
    const m = goMod.match(/^module\s+(\S+)/m);
    expect(m).not.toBeNull();
    const livePath = m![1]!;
    expect(doc).toContain(livePath);
  });

  it('quoted tier-cap numbers match TIER_CONCURRENT_SESSION_LIMITS', () => {
    expect(doc).toMatch(new RegExp(`Free: ${TIER_CONCURRENT_SESSION_LIMITS.free}`));
    expect(doc).toMatch(new RegExp(`API Starter: ${TIER_CONCURRENT_SESSION_LIMITS.api_starter}`));
    expect(doc).toMatch(new RegExp(`API Builder: ${TIER_CONCURRENT_SESSION_LIMITS.api_builder}`));
    expect(doc).toMatch(new RegExp(`API Scale: ${TIER_CONCURRENT_SESSION_LIMITS.api_scale}`));
  });

  it('cites the ds_live_ key prefix per the schema', () => {
    expect(doc).toMatch(/ds_live_/);
    const types = read(resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts'));
    expect(types).toMatch(/ds_live_/);
  });

  it('Sessions methods cited exist on the live TS SDK', () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/sessions.ts'));
    for (const m of ['create', 'navigate', 'capture', 'destroy']) {
      expect(doc).toContain(`client.sessions.${m}`);
      expect(ts).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it('Sessions methods cited exist on the live Python SDK', () => {
    const py = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/sessions.py'));
    for (const m of ['create', 'navigate', 'capture', 'destroy']) {
      expect(py).toMatch(new RegExp(`\\bdef\\s+${m}\\s*\\(`));
    }
  });

  it('Sessions methods cited exist on the live Go SDK', () => {
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/sessions.go'));
    for (const m of ['Create', 'Navigate', 'Capture', 'Destroy']) {
      expect(doc).toContain(`client.Sessions.${m}`);
      expect(go).toMatch(new RegExp(`func\\s+\\(.+?SessionsResource\\)\\s+${m}\\b`));
    }
  });

  it('Node + Python + Go version requirements line up with the per-SDK quickstarts (2026-06-24: go.mod declares go 1.22, so the Go floor is 1.22+, was a stale 1.21+)', () => {
    expect(doc).toMatch(/Node\.js 18\+/);
    expect(doc).toMatch(/Python 3\.10\+/);
    expect(doc).toMatch(/Go 1\.22\+/);
    // The stale Go 1.21+ floor must NOT return.
    expect(doc).not.toMatch(/Go 1\.21\+/);
  });

  it('cross-link targets exist', () => {
    for (const href of [
      '/guides/profile-management',
      '/guides/session-lifecycle',
      '/webhooks/events',
      '/api/versioning',
      '/sdk/installation',
    ]) {
      expect(doc).toContain(href);
      const stem = href.replace(/^\//, '');
      const candidates = [`${stem}.md`, `${stem}.astro`, `${stem}/index.md`, `${stem}/index.astro`];
      expect(candidates.some((c) => existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages', c)))).toBe(
        true,
      );
    }
  });

  it('states that code/SDK access is paid while Free uses an automatic restricted desktop credential', () => {
    expect(doc).toMatch(/This code quickstart requires a paid tier with API access/);
    expect(doc).toMatch(/including the Manual tiers/);
    expect(doc).toMatch(/automatically stores a restricted `ds_test_…` device credential/);
    expect(doc).toMatch(/not a general sandbox or SDK key/);
  });
});
