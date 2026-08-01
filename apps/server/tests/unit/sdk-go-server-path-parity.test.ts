// W250.B — drift-guard between the Go SDK and the server's
// registered routes. Mirrors W249.C (TS) / W250.A (Python). The Go
// SDK constructs paths as Go string-concatenation expressions like
// `"/v1/sessions/" + url.PathEscape(sessionID) + "/navigate"`. We
// normalise those concatenations to `:p` placeholders before
// comparing against the server's normalised path set.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const SDK_GO = join(REPO, 'packages', 'sdk-go');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function readAll(dir: string, ext: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out += readAll(p, ext);
    else if (entry.name.endsWith(ext) && !entry.name.endsWith('_test.go')) {
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

describe('W250.B SDK-go ↔ server path parity', () => {
  // Same change as the Python twin, for the same measured reason: the Go SDK is
  // 64 git-tracked files in a workspace package, never an optional dependency,
  // so `it.skip('Go SDK not present')` could only fire when the directory moved
  // — and it reported a green suite while this guard stopped running entirely.
  it('CRITICAL the Go SDK directory is where this guard expects it. If it moves, the path-parity assertion below silently stops being made while the suite still reads as green.', () => {
    expect(
      safeStat(SDK_GO),
      `${SDK_GO} is not a directory — if the SDK layout changed, update this guard in the same commit rather than letting it skip`,
    ).toBe(true);
  });

  it('every Go SDK path expression resolves to a server route', () => {
    const sdkBlob = readAll(SDK_GO, '.go');
    const serverBlob = walkServerTs(SERVER_SRC);
    const sdkPaths = new Set<string>();
    // Match lines that look like `path: "/v1/..." + url.PathEscape(...) + "/segment"`
    // — concatenated string expressions. Pull every contiguous chunk.
    for (const m of sdkBlob.matchAll(
      /path:\s*((?:"[^"]+"|\s*\+\s*|url\.PathEscape\([a-zA-Z_]+\))+)/g,
    )) {
      let expr = m[1]!;
      // Replace url.PathEscape(...) with :p
      expr = expr.replace(/url\.PathEscape\([a-zA-Z_]+\)/g, ':p');
      // Concatenate adjacent string literals: strip `" + "` and surrounding quotes.
      // Simplest: pull everything between quotes, replace + chains with ''.
      // After PathEscape→":p" replacement, what remains is `"…" + :p + "…"`.
      // Strip ` + ` and surrounding quote pairs.
      const path = expr
        .replace(/"\s*\+\s*"/g, '')
        .replace(/"\s*\+\s*:p\s*\+\s*"/g, ':p')
        .replace(/"\s*\+\s*:p/g, ':p')
        .replace(/:p\s*\+\s*"/g, ':p')
        .replace(/^"/, '')
        .replace(/"$/, '')
        .replace(/(?::p)+/g, ':p');
      if (path.startsWith('/v1/')) {
        sdkPaths.add(path);
      }
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
