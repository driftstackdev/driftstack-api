// Every endpoint the docs promise is actually registered.
//
// A customer reading docs.driftstack.io and getting a 404 has no way to tell
// whether they mistyped, lack a scope, or are looking at a page that describes
// something we never shipped. Nothing checked the last case.
//
// Both sides are read from source: routes from `app.<verb>('<path>')` across
// routes/* and lib/app.ts, documented endpoints from the canonical backticked
// form the API pages use — `GET /v1/sessions`. Paths are normalised so `{id}`
// and `:id` compare equal.
//
// The backtick requirement is doing real work. Matching a bare `VERB /v1/...`
// anywhere in prose produced five false alarms out of five: a path broken across
// a line wrap (`/v1/billing/crypto-`), a prefix mentioned in a sentence
// (`/v1/legal`), a trailing full stop, and `GET /v1/models` — which is
// ANTHROPIC's endpoint, named in the BYOK page because customers call it with
// their own key. None of those is a promise about our API. Restricting to the
// backticked form leaves 146 real ones and no noise.
//
// This asserts one direction only. The reverse — a route with no documentation —
// is a different question with different answers (health probes, internal fleet
// endpoints and the box's egress-echo diagnostic are all deliberately
// undocumented), and a naive version of it over-reports badly: it flagged
// /v1/agent-sessions, which appears in twelve docs pages.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', '..', 'src');
const DOCS = resolve(HERE, '..', '..', '..', 'docs', 'src', 'pages');

type Endpoint = `${string} ${string}`;

/**
 * Non-comment lines. A commented-out route registration is not a route, and a
 * doc-block example of one is not either.
 */
function codeLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** `{id}` and `:id` both become `:p`, so the two vocabularies compare. */
function norm(path: string): string {
  return path
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_]+/g, ':p')
    .replace(/\/+$/, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Routes the server registers. lib/app.ts matters — /v1/whoami lives there. */
function registered(): Set<Endpoint> {
  const files = [
    ...readdirSync(resolve(SERVER, 'routes'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => resolve(SERVER, 'routes', f)),
    resolve(SERVER, 'lib', 'app.ts'),
  ];
  const out = new Set<Endpoint>();
  for (const file of files) {
    for (const m of codeLines(file).matchAll(
      /\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*[\r\n]?\s*'([^']+)'/g,
    )) {
      out.add(`${(m[1] ?? '').toUpperCase()} ${norm(m[2] ?? '')}`);
    }
  }
  return out;
}

/** Endpoints the docs promise, in the canonical backticked form. */
function documented(): Map<Endpoint, string[]> {
  const out = new Map<Endpoint, string[]>();
  for (const file of walk(DOCS).filter((f) => /\.mdx?$/.test(f))) {
    for (const m of readFileSync(file, 'utf8').matchAll(
      /`(GET|POST|PUT|PATCH|DELETE) (\/v1\/[A-Za-z0-9/_:{}.-]*)`/g,
    )) {
      const key: Endpoint = `${m[1] ?? ''} ${norm(m[2] ?? '')}`;
      out.set(key, [...(out.get(key) ?? []), file.slice(DOCS.length + 1)]);
    }
  }
  return out;
}

describe('every documented endpoint exists', () => {
  const routes = registered();
  const docs = documented();

  it('CRITICAL both scans found their populations, and each finds a known member', () => {
    // The positive control. This file asserts a set difference is EMPTY, which a
    // broken scan on either side produces for free — an empty docs set has
    // nothing missing, and an all-seeing route set covers everything. A first
    // draft of the route scan matched only single-line registrations and found
    // 61 of 252, silently; the controls below are what caught it.
    expect(
      routes.size,
      'route scan came back short — registrations are multi-line',
    ).toBeGreaterThan(200);
    expect(
      docs.size,
      'doc scan came back short — the backticked form may have changed',
    ).toBeGreaterThan(100);
    for (const known of [
      'POST /v1/sessions',
      'GET /v1/whoami',
      'GET /v1/legal/documents',
    ] as const) {
      expect(routes, `${known} is registered but the route scan missed it`).toContain(known);
    }
    for (const known of ['POST /v1/sessions', 'GET /v1/legal/documents'] as const) {
      expect([...docs.keys()], `${known} is documented but the doc scan missed it`).toContain(
        known,
      );
    }
  });

  it('CRITICAL no documented endpoint is missing from the server', () => {
    const missing = [...docs.entries()]
      .filter(([ep]) => !routes.has(ep))
      .map(([ep, files]) => `${ep} (${[...new Set(files)].sort().join(', ')})`)
      .sort();
    expect(
      missing,
      'the docs promise an endpoint the server does not register, so a customer following the ' +
        'page gets a 404 with no way to tell whether they mistyped, lack a scope, or are reading ' +
        'about something that was never shipped',
    ).toEqual([]);
  });
});
