// W214.C — drift-guard between /docs/sdk-typescript and the
// @driftstack/sdk public surface.
//
// The previous doc claimed methods that don't exist
// (`waitUntilTerminal`, `recordings.get`, `sessions.stream`) and a
// request body shape (`target_url`, `profile_archetype`) the
// SessionsResource doesn't accept. An integrator copy-pasting the
// example would hit a runtime "is not a function" error. This guard
// pins each method shown in the doc to a method that actually exists
// on SessionsResource (or another SDK resource).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'sdk-typescript.astro',
);
const SESSIONS_PATH = join(REPO, 'packages', 'sdk-typescript', 'src', 'resources', 'sessions.ts');
const INDEX_PATH = join(REPO, 'packages', 'sdk-typescript', 'src', 'index.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W214.C sdk-typescript doc parity', () => {
  const doc = read(DOC_PATH);
  const sessions = read(SESSIONS_PATH);
  const index = read(INDEX_PATH);

  it('every client.sessions.<method>() call in the doc maps to a real method', () => {
    const calls = Array.from(doc.matchAll(/client\.sessions\.([A-Za-z_]+)\(/g)).map((m) => m[1]!);
    expect(calls.length, 'doc must call client.sessions methods').toBeGreaterThan(0);
    const realMethods = [
      'create',
      'list',
      'iterate',
      'navigate',
      'interact',
      'wait',
      'getState',
      'capture',
      'destroy',
    ];
    for (const fn of calls) {
      expect(
        realMethods,
        `client.sessions.${fn}() referenced in doc but not on SessionsResource`,
      ).toContain(fn);
      // Also confirm the SDK file actually exposes it (sanity check).
      expect(sessions, `SessionsResource missing ${fn}()`).toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });

  it('doc does not reference fictional resources or helpers', () => {
    // The previous version claimed client.recordings.get, client.sessions.stream,
    // client.sessions.waitUntilTerminal, and client.sessions.start — none exist.
    expect(doc).not.toMatch(/client\.recordings\./);
    expect(doc).not.toMatch(/client\.sessions\.stream\(/);
    expect(doc).not.toMatch(/waitUntilTerminal/);
    expect(doc).not.toMatch(/client\.sessions\.start\(/);
    expect(doc).not.toMatch(/sessions\.get\(/);
  });

  it('session-create body uses archetype/purpose, not target_url/profile_archetype', () => {
    // The doc's example must use the real schema fields.
    expect(doc).toMatch(/archetype:\s*'default'/);
    // And not the stale ones:
    expect(doc).not.toMatch(/target_url:/);
    expect(doc).not.toMatch(/profile_archetype:/);
  });

  it('return shape is not a {session} envelope', () => {
    // The actual return is a Session directly; the old doc destructured
    // `const { session } = await client.sessions.start(...)`.
    expect(doc).not.toMatch(/\{\s*session\s*\}\s*=\s*await client\.sessions/);
  });

  it('error kinds named in the doc exist in DriftstackErrorKind', () => {
    // Read the kinds string union from errors.ts.
    const errorsTs = read(join(REPO, 'packages', 'sdk-typescript', 'src', 'errors.ts'));
    const block = errorsTs.split('export type DriftstackErrorKind =')[1]!.split(';')[0]!;
    const knownKinds = Array.from(block.matchAll(/'([^']+)'/g)).map((m) => m[1]!);
    const docKinds = Array.from(doc.matchAll(/err\.kind === '([^']+)'/g)).map((m) => m[1]!);
    expect(docKinds.length, 'doc must demonstrate at least one kind check').toBeGreaterThan(0);
    for (const k of docKinds) {
      expect(knownKinds, `doc references err.kind === '${k}' but that's not a real kind`).toContain(
        k,
      );
    }
  });

  it('DriftstackError is actually exported from the SDK index', () => {
    expect(index).toMatch(/DriftstackError,/);
  });
});
