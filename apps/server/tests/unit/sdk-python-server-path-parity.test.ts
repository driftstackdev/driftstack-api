// W250.A — drift-guard between the Python SDK and the server's
// registered routes. Mirrors W249.C for the TypeScript SDK. Every
// `/v1/...` literal in the python resources files must correspond
// to a server-side route registration (after id-placeholder
// normalisation).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const SDK_RESOURCES = join(REPO, 'packages', 'sdk-python', 'src', 'driftstack', 'resources');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function readAll(dir: string, ext: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out += readAll(p, ext);
    else if (entry.name.endsWith(ext)) {
      out += readFileSync(p, 'utf8') + '\n';
    }
  }
  return out;
}

function walkServerTs(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out += walkServerTs(p);
    else if (entry.name.endsWith('.ts')) {
      out += readFileSync(p, 'utf8') + '\n';
    }
  }
  return out;
}

function safeStat(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

describe('W250.A SDK-python ↔ server path parity', () => {
  // The directory check used to early-return `it.skip('python SDK not present')`.
  // The Python SDK is not an optional dependency — it is 21 git-tracked files in
  // a workspace package of this repo, with no submodule anywhere — so that branch
  // could only ever fire when the directory was renamed, moved, or deleted. In
  // other words it fired exactly when this guard mattered most, and it reported
  // "1 passed | 1 skipped", which is a green suite. Measured, not assumed:
  // pointing SDK_RESOURCES at a non-existent path left the run green.
  //
  // A missing directory is now a failure. The reads moved inside the cases so a
  // missing directory surfaces as this test failing rather than as a collection
  // crash that stops the presence case from ever running.
  it('CRITICAL the Python SDK resources directory is where this guard expects it. If it moves, every path-parity assertion below silently stops being made — and a guard that disappears quietly is worse than one that never existed, because the suite still reads as green.', () => {
    expect(
      safeStat(SDK_RESOURCES),
      `${SDK_RESOURCES} is not a directory — if the SDK layout changed, update this guard in the same commit rather than letting it skip`,
    ).toBe(true);
  });

  it('every Python SDK path literal resolves to a server route', () => {
    // Preprocess the Python source so f-string placeholders like
    // `{quote(id, safe='')}` don't break our simple ["'](/v1/...)["'] regex
    // (the embedded `''` confuses the closing-quote match). Replace any
    // `{…}` Python f-string placeholder with a single `:p` token first.
    const rawPython = readAll(SDK_RESOURCES, '.py');
    const sdkBlob = rawPython.replace(/\{[^{}]*\}/g, ':p');
    const serverBlob = walkServerTs(SERVER_SRC);
    const sdkPaths = new Set<string>();
    // Python uses both bare strings ("/v1/foo") and f-strings (f"/v1/foo/{x}").
    // Capture both; normalise `{var}` and `{quote(var, safe='')}` to `:p`.
    for (const m of sdkBlob.matchAll(/["'](\/v1\/[^"']+)["']/g)) {
      const raw = m[1]!;
      // Already pre-normalized via {…} → :p above. Collapse consecutive
      // :p tokens (e.g. `/foo/:p:p` ← `/foo/{a}{b}` adjacency) into one.
      const normalized = raw
        .replace(/(?::p)+/g, ':p')
        .replace(/\?.*$/, '')
        .replace(/\/$/, '');
      sdkPaths.add(normalized);
    }
    expect(sdkPaths.size).toBeGreaterThan(10);

    const serverPaths = new Set<string>();
    for (const m of serverBlob.matchAll(/['"](\/v1\/[A-Za-z0-9:_./-]+)['"]/g)) {
      const raw = m[1]!;
      const normalized = raw.replace(/:[a-zA-Z_]+/g, ':p').replace(/\/$/, '');
      serverPaths.add(normalized);
    }

    const missing = [...sdkPaths].filter((p) => !serverPaths.has(p));
    expect(missing).toEqual([]);
  });
});
