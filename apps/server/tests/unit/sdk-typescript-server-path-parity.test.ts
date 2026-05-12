// W249.C — drift-guard between the TypeScript SDK and the server's
// registered routes. Every `path: '/v1/...'` literal in the SDK
// resources must correspond to a server-side route registration.
// Catches the case where an SDK method points at a stale path after
// a server-side rename.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const SDK_RESOURCES = join(REPO, 'packages', 'sdk-typescript', 'src', 'resources');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function readAll(dir: string, ext: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out += readAll(p, ext);
    } else if (entry.name.endsWith(ext)) {
      out += readFileSync(p, 'utf8');
      out += '\n';
    }
  }
  return out;
}

describe('W249.C SDK-typescript ↔ server path parity', () => {
  const sdkBlob = readAll(SDK_RESOURCES, '.ts');
  const serverBlob = readAll(SERVER_SRC, '.ts');

  it('every SDK path literal resolves to a server route', () => {
    // Normalise a path: replace `${encodeURIComponent(x)}` and any
    // other ${…} placeholder with `:p`. Then look for the same
    // normalised shape on the server side, also normalising server
    // `:param` segments.
    const sdkPaths = new Set<string>();
    for (const m of sdkBlob.matchAll(/path:\s*[`'"]([^`'"]+)[`'"]/g)) {
      const raw = m[1]!;
      if (!raw.startsWith('/v1/')) continue;
      // SDK uses template literals like `/v1/foo/${encodeURIComponent(id)}/bar`.
      const normalized = raw.replace(/\$\{[^}]+\}/g, ':p').replace(/\/$/, '');
      sdkPaths.add(normalized);
    }
    expect(sdkPaths.size).toBeGreaterThan(10);

    const serverPaths = new Set<string>();
    for (const m of serverBlob.matchAll(/['"](\/v1\/[A-Za-z0-9:_./-]+)['"]/g)) {
      const raw = m[1]!;
      // Server-side `:foo` to `:p` for comparison.
      const normalized = raw.replace(/:[a-zA-Z_]+/g, ':p').replace(/\/$/, '');
      serverPaths.add(normalized);
    }

    const missing = [...sdkPaths].filter((p) => !serverPaths.has(p));
    expect(missing).toEqual([]);
  });
});
