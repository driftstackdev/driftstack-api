// Every route the app registers is driven by at least one HTTP-level test.
//
// Everything else in this suite tests a layer: a repo method, a service, a
// handler in isolation. This asks the one question none of those can — does any
// test actually ISSUE this request against a booted app? A route can be added
// with a fully-tested service behind it and still never be reached over HTTP,
// and nothing in the suite would notice.
//
// Ground truth comes from Fastify itself (`printRoutes`), not from grepping
// `app.get(...)` out of the source. That distinction is the whole reason this
// file is trustworthy: a regex over `src/routes/*.ts` finds 154 routes, and the
// app actually registers 232 — it misses a third of the surface, because plenty
// of routes are registered from helpers and nested plugins rather than as one
// literal call. A coverage claim built on the regex would have been measured
// over two thirds of the app while reading as complete.
//
// Two corpora count as driving a route: `tests/e2e` (Playwright against a real
// booted server) and `tests/integration` (inject/fetch against a built app).
//
// SCOPE, stated because it bounds the claim: routes registered CONDITIONALLY on
// an injected dependency (OAuth needs `deps.oauthStore`, LiveKit needs its
// credentials) are absent from the default test app and therefore out of scope
// here. This asserts the default surface is fully driven, not that every
// optional route is.

import { describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = resolve(HERE, '..');

/**
 * Turn Fastify's printRoutes tree into (METHOD, path) pairs.
 *
 * Depth comes from the COLUMN of the branch marker, four characters per level.
 * An earlier version inferred depth from a leading-character run and silently
 * produced 86 routes with every nested path missing — which is why the caller
 * asserts on known routes rather than trusting the count.
 */
function parseRouteTree(tree: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const stack = new Map<number, string>();
  for (const raw of tree.split('\n')) {
    if (raw.trim() === '') continue;
    const marker = /(├── |└── )/.exec(raw);
    const depth = marker ? Math.floor(marker.index / 4) : 0;
    const rest = marker ? raw.slice(marker.index + marker[0].length) : raw.trim();
    const parsed = /^(\S*)\s*(?:\(([^)]*)\))?\s*$/.exec(rest);
    if (!parsed) continue;
    const [, segment, methods] = parsed;
    stack.set(depth, segment ?? '');
    for (const d of [...stack.keys()]) if (d > depth) stack.delete(d);
    if (methods === undefined) continue;
    const path = [...stack.keys()]
      .sort((a, b) => a - b)
      .map((d) => stack.get(d) ?? '')
      .join('');
    for (const method of methods.split(',').map((m) => m.trim())) {
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) out.push({ method, path });
    }
  }
  return out;
}

/** `/v1/sessions/:id/interact` must match `${base}/v1/sessions/${id}/interact` but not `/v1/sessions`. */
function routeMatcher(path: string): RegExp {
  const body = path
    .split('/')
    .map((seg) =>
      seg.startsWith(':') ? '[^\'"`/\\s)]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(body);
}

function readCorpus(): string {
  const chunks: string[] = [];
  for (const dir of ['e2e', 'integration']) {
    const root = join(TESTS_DIR, dir);
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) chunks.push(readFileSync(full, 'utf-8'));
      }
    };
    walk(root);
  }
  return chunks.join('\n');
}

describe('every registered route is driven over HTTP by some test', () => {
  it('CRITICAL no route ships without an end-to-end caller', async () => {
    const fixture = (await buildTestApp()) as unknown as {
      app: { printRoutes: (o?: unknown) => string };
      close?: () => Promise<void>;
    };
    let routes: Array<{ method: string; path: string }>;
    try {
      routes = parseRouteTree(fixture.app.printRoutes({ commonPrefix: false }));
    } finally {
      await fixture.close?.();
    }

    // The parser is the fragile part, so it fails LOUDLY rather than reporting a
    // comfortable zero. If Fastify changes its tree art these assertions break
    // first and say so, instead of the sweep below passing over an empty set.
    expect(routes.length, 'parsed far fewer routes than the app registers').toBeGreaterThan(200);
    for (const known of [
      { method: 'POST', path: '/v1/sessions' },
      { method: 'POST', path: '/v1/sessions/:id/interact' }, // nested — the case the bad parser lost
      { method: 'DELETE', path: '/v1/api-keys/:id' },
      { method: 'GET', path: '/healthz' }, // outside /v1
    ]) {
      expect(
        routes.some((r) => r.method === known.method && r.path === known.path),
        `route tree parse lost ${known.method} ${known.path}`,
      ).toBe(true);
    }

    const corpus = readCorpus();
    const undriven = routes
      .filter((r) => !routeMatcher(r.path).test(corpus))
      .map((r) => `${r.method} ${r.path}`);

    expect(
      undriven,
      'these routes are registered but no e2e or integration test ever issues the request',
    ).toEqual([]);
  });
});
