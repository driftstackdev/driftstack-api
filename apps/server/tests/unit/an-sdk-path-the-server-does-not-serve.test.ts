// Every wire path an SDK calls is one this server actually registers.
//
// `openapi-route-coverage-invariant` guards the other direction and names its
// hazard exactly: "an endpoint the API serves and no SDK can call." The mirror is
// worse and had no guard — a path an SDK calls and the server does not serve is not
// a missing feature, it is a 404 on every customer request through that method, and
// nothing in this repo would have failed.
//
// `cross-sdk-verb-parity` compares the three SDKs to EACH OTHER. That is a real
// invariant and it is derived rather than hand-listed, but three SDKs agreeing on a
// wrong path satisfies it perfectly. It has no view of the server.
//
// So the composition is: this file asserts sdk-typescript ⊆ server, and
// `cross-sdk-verb-parity` asserts the TypeScript, Python and Go path sets are equal.
// Together they place all three SDKs inside the server's route table. Neither half
// is sufficient alone, and the scope is stated here rather than implied so nobody
// reads this as covering Python and Go directly — it covers them THROUGH that file.
//
// V-1425 — written after checking this by hand for six consecutive batches
// (V-1419..V-1424, auth / profiles / account / sessions / usage / agent-sessions).
// Every one matched, which is the argument for automating it rather than against:
// the manual pass is what a person stops doing, and the class it protects against is
// real. The `?keep=current` defect recorded in `untested-resources` was one method
// sending a URL the server refused, unnoticed because every guard pinned the method
// SIGNATURE and none compared the request to a route.
//
// ⚠️ The extractor is the fragile part, and its first draft produced a FALSE
// POSITIVE: it scanned four lines after each `app.<verb>(` for the path literal, and
// `/v1/billing/crypto-orders` is registered under a multi-line generic that pushes
// the literal further down. A guard that reports a legitimate route as missing is
// worse than no guard, because it fails a commit for a defect that is not there.
// Hence the window below, and hence the census self-check: an extractor that silently
// stops matching would otherwise report "no missing paths" forever.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK_RESOURCES = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
const SERVER_ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

/** Collapse every parameter spelling to one token so the two sides compare.
 *  SDK writes `${encodeURIComponent(id)}`; the server writes `:order_id`. */
function normalise(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
    .replace(/\/+$/, '');
}

function sdkPaths(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(SDK_RESOURCES)) {
    if (!file.endsWith('.ts')) continue;
    const body = readFileSync(resolve(SDK_RESOURCES, file), 'utf8');
    for (const m of body.matchAll(/path:\s*[`']([^`']*)[`']/g)) {
      const p = m[1] ?? '';
      if (p.startsWith('/v1/')) out.add(normalise(p));
    }
  }
  return out;
}

function serverPaths(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(SERVER_ROUTES)) {
    if (!file.endsWith('.ts')) continue;
    const lines = readFileSync(resolve(SERVER_ROUTES, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/app\.(get|post|put|patch|delete)\b/.test(line)) return;
      // The path is the first argument, but a generic type parameter can span
      // several lines before it. Scan until the literal appears or the next
      // registration begins — a fixed small window is what produced the false
      // positive this file's header describes.
      for (let j = i; j < Math.min(i + 20, lines.length); j += 1) {
        if (j > i && /app\.(get|post|put|patch|delete)\b/.test(lines[j] ?? '')) break;
        const pm = /'(\/v1\/[^']*)'/.exec(lines[j] ?? '');
        if (pm?.[1] !== undefined) {
          out.add(normalise(pm[1]));
          break;
        }
      }
    });
  }
  return out;
}

describe('an SDK path the server does not serve', () => {
  const sdk = sdkPaths();
  const server = serverPaths();

  it('CRITICAL the census found paths on BOTH sides. An extractor that stops matching reports zero missing paths forever, which is the failure mode this whole file would otherwise hide — the same shape as a declaration list that agrees with anything because it is empty.', () => {
    expect(sdk.size, 'no /v1 paths extracted from the SDK resource files').toBeGreaterThan(80);
    expect(server.size, 'no /v1 routes extracted from the server route files').toBeGreaterThan(150);
  });

  it('CRITICAL every path the TypeScript SDK calls is registered by this server. A path the SDK sends and the server does not serve 404s every customer request through that method, and no other guard in this repo compares the two: the OpenAPI invariant walks server-to-spec, and the cross-SDK parity file compares the three SDKs to each other, where all three agreeing on a wrong path passes.', () => {
    const unserved = [...sdk].filter((p) => !server.has(p)).sort();
    expect(
      unserved,
      'SDK path(s) with no matching server route — every call through these 404s:',
    ).toEqual([]);
  });

  it('the parameterised spellings really do collapse together, so the comparison above is not passing on a normalisation that flattens everything. `/v1/profiles/:p` and `/v1/profiles` must stay distinct.', () => {
    expect(normalise('/v1/profiles/${encodeURIComponent(id)}/launch')).toBe(
      '/v1/profiles/:p/launch',
    );
    expect(normalise('/v1/billing/crypto-orders/:order_id/receipt')).toBe(
      '/v1/billing/crypto-orders/:p/receipt',
    );
    expect(normalise('/v1/profiles/${id}')).not.toBe(normalise('/v1/profiles'));
  });
});
