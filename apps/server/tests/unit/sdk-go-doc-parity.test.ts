// W215.B — drift-guard between /docs/sdk-go and the
// `github.com/driftstack/driftstack-go` package's public surface.
//
// Parses sessions.go to derive the real method set and pins every
// `client.Sessions.<Name>(` mention in the doc to it. Also verifies
// the Go SessionStatus constants the doc claims actually exist as
// declared in types.go.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'sdk-go.astro');
const SESSIONS_PATH = join(REPO, 'packages', 'sdk-go', 'sessions.go');
const TYPES_PATH = join(REPO, 'packages', 'sdk-go', 'types.go');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W215.B sdk-go doc parity', () => {
  const doc = read(DOC_PATH);
  const sessions = read(SESSIONS_PATH);
  const types = read(TYPES_PATH);

  it('every client.Sessions.<Name>() call in the doc maps to a real Go method', () => {
    const calls = Array.from(doc.matchAll(/client\.Sessions\.([A-Z][A-Za-z0-9]*)\(/g)).map(
      (m) => m[1]!,
    );
    expect(calls.length, 'doc must call client.Sessions methods').toBeGreaterThan(0);
    const methods = Array.from(
      sessions.matchAll(/func\s+\(r \*SessionsResource\)\s+([A-Z][A-Za-z0-9]*)\(/g),
    ).map((m) => m[1]!);
    expect(methods.length).toBeGreaterThan(0);
    const real = new Set(methods);
    for (const fn of calls) {
      expect(real.has(fn), `client.Sessions.${fn}() in doc but not on SessionsResource`).toBe(true);
    }
  });

  it('doc does not reference fictional methods or resources', () => {
    expect(doc).not.toMatch(/client\.Sessions\.Start\(/);
    expect(doc).not.toMatch(/client\.Sessions\.Stream\(/);
    expect(doc).not.toMatch(/WaitUntilTerminal/);
    expect(doc).not.toMatch(/client\.Recordings\./);
  });

  it('session-create body uses Archetype/Purpose, not TargetURL/ProfileArchetype', () => {
    expect(doc).not.toMatch(/TargetURL:/);
    expect(doc).not.toMatch(/ProfileArchetype:/);
    // The CreateSessionRequest example sets Purpose with the typed
    // SessionPurpose constant and references the Archetype field
    // (omitted in the example to inherit the locked launch default).
    expect(doc).toMatch(/Purpose:\s*driftstack\.PurposeProductionCustomer/);
    expect(doc).toMatch(/Archetype/);
  });

  it('SessionStatus constants named in the doc exist in types.go', () => {
    const block = types.split('SessionStatus = "')[0]!; // not used; below extracts properly
    void block;
    const consts = Array.from(
      types.matchAll(/^\s+(Session[A-Z][A-Za-z]+)\s+SessionStatus\s*=/gm),
    ).map((m) => m[1]!);
    expect(consts.length, 'must find at least one SessionStatus const').toBeGreaterThan(0);
    const real = new Set(consts);
    const referenced = Array.from(
      doc.matchAll(/\bSession(?:Creating|Ready|Busy|Destroyed|Errored)\b/g),
    ).map((m) => m[0]);
    expect(
      referenced.length,
      'doc should reference at least one SessionStatus const',
    ).toBeGreaterThan(0);
    for (const c of referenced) {
      expect(real.has(c), `doc references ${c} but it does not exist in types.go`).toBe(true);
    }
    // The stale constants must not appear.
    for (const stale of ['StatusQueued', 'StatusRunning', 'StatusCompleted', 'StatusFailed']) {
      expect(doc).not.toMatch(new RegExp(`\\b${stale}\\b`));
    }
  });
});
