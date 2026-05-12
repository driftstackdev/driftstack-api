// W215.A — drift-guard between /docs/sdk-python and the
// `driftstack` Python package's public surface.
//
// Parses the Python sessions.py source to derive the real method set
// and pins every `client.sessions.<name>(` mention in the doc to it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'sdk-python.astro');
const SESSIONS_PATH = join(
  REPO,
  'packages',
  'sdk-python',
  'src',
  'driftstack',
  'resources',
  'sessions.py',
);
const INIT_PATH = join(REPO, 'packages', 'sdk-python', 'src', 'driftstack', '__init__.py');
const ERRORS_PATH = join(REPO, 'packages', 'sdk-python', 'src', 'driftstack', 'errors.py');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function methodsFromSyncResource(src: string): string[] {
  // Take everything between `class SessionsResource:` and the next
  // `class ` declaration. Then pull `def <name>(` lines.
  const slice = src.split('class SessionsResource:')[1]?.split('\nclass ')[0] ?? '';
  return Array.from(slice.matchAll(/^\s+def\s+([a-z_][a-z0-9_]*)\s*\(/gm))
    .map((m) => m[1]!)
    .filter((n) => !n.startsWith('_'));
}

describe('W215.A sdk-python doc parity', () => {
  const doc = read(DOC_PATH);
  const sessions = read(SESSIONS_PATH);

  it('every client.sessions.<method>() call in the doc maps to a real method', () => {
    const calls = Array.from(doc.matchAll(/client\.sessions\.([a-z_][a-z0-9_]*)\(/g)).map(
      (m) => m[1]!,
    );
    expect(calls.length, 'doc must call client.sessions methods').toBeGreaterThan(0);
    const real = new Set(methodsFromSyncResource(sessions));
    expect(real.size, 'parser must find at least one real method').toBeGreaterThan(0);
    for (const fn of calls) {
      expect(real.has(fn), `client.sessions.${fn}() in doc but not on SessionsResource`).toBe(true);
    }
  });

  it('doc does not reference fictional methods or resources', () => {
    expect(doc).not.toMatch(/client\.sessions\.start\(/);
    expect(doc).not.toMatch(/client\.sessions\.stream\(/);
    expect(doc).not.toMatch(/wait_until_terminal/);
    expect(doc).not.toMatch(/client\.recordings\./);
  });

  it('session-create body uses archetype/purpose, not target_url/profile_archetype', () => {
    expect(doc).not.toMatch(/target_url=/);
    expect(doc).not.toMatch(/profile_archetype=/);
    expect(doc).toMatch(/"archetype":\s*"default"/);
  });

  it('driftstack package exports Driftstack and AsyncDriftstack', () => {
    const initSrc = read(INIT_PATH);
    expect(initSrc).toMatch(/\bDriftstack\b/);
    expect(initSrc).toMatch(/\bAsyncDriftstack\b/);
  });

  it('error subclasses named in the doc exist in driftstack.errors', () => {
    const errors = read(ERRORS_PATH);
    // We expect the doc to import ValidationError + RateLimitError —
    // both are stable, well-known DriftstackError subclasses.
    for (const cls of ['ValidationError', 'RateLimitError']) {
      expect(doc, `doc references ${cls}`).toContain(cls);
      expect(errors, `${cls} should exist in driftstack/errors.py`).toMatch(
        new RegExp(`class ${cls}\\b`),
      );
    }
  });
});
