// W207 — drift guard between the customer-facing /api-reference page
// and the actual Fastify route registrations.
//
// Background: api-reference.astro lists a curated set of common endpoints as
// quick nav cues (`GET /v1/sessions`, `POST /v1/billing/checkout-session`).
// Two earlier bugs found in this audit: the doc listed
// `/v1/billing/checkout` (real route: `/v1/billing/checkout-session`)
// and `/v1/auth/magic-link` (real routes are `magic-link/request` and
// `magic-link/consume`). Customers reading the doc to script raw
// HTTP calls would hit 404s.
//
// Two checks, because until V-1027 this header described only the second and
// the file implemented only the first:
//
//   1. Absolute `https://api.driftstack.dev/v1/...` URLs — the curl samples,
//      six of them — matched loosely against the route literals, so Fastify
//      type-parameter sugar like `app.post<{...}>('/v1/...', …)` is tolerated.
//   2. The bare `METHOD /v1/path` entries on api-reference.astro, 88 of them,
//      matched against actual registrations by verb AND path. That is the shape
//      both bugs above had. Its sibling `api-reference-surface-doc-parity` checks
//      a hand-picked roster of about ten, so roughly seventy-eight customer-facing
//      listings were verified by nothing until V-1027.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Note: `readdirSync`, `statSync`, `join` may look unused at first
// glance — they're used by the W209 walk below.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const API_REF = readFileSync(
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro'),
  'utf8',
);
// W208 — also scan the curl quickstart for /v1/... mentions. The
// quickstart uses bare URL literals
// (`https://api.driftstack.dev/v1/sessions/...`) rather than the
// `<li>METHOD path</li>` shape, so we extract them with a different
// regex below.
// S47 2026-07-07 (founder-approved: mirror deprecation): the legacy
// /docs/api-quickstart mirror page is deleted (301 →
// docs.driftstack.io/quickstart-curl/), so this guard now scans the
// docs successor source — same bug class (documented endpoint that
// the server never registers), same URL-literal shape.
const API_QUICKSTART = readFileSync(
  resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart-curl.md'),
  'utf8',
);
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

// Concatenate every route file so a single .includes() scan tells us
// if a path is registered anywhere.
function readAllRouteSources(): string {
  const buf: string[] = [];
  for (const entry of readdirSync(ROUTES_DIR)) {
    const full = join(ROUTES_DIR, entry);
    if (statSync(full).isFile() && entry.endsWith('.ts')) {
      buf.push(readFileSync(full, 'utf8'));
    }
  }
  return buf.join('\n');
}

const ROUTES_SOURCE = readAllRouteSources();

// Pull every `<li>METHOD /v1/path</li>` from the api-reference doc.
const LI_RE = /<li>(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[A-Za-z0-9_/:.-]+?)<\/li>/g;

// Endpoints the doc lists that are intentional partials / parameterised
// paths the server doesn't register verbatim. Keep this list small;
// every entry is a deliberate exception.
const KNOWN_PARTIAL_PATHS = new Set<string>([
  // Per-resource by-id paths use Fastify ':param' style in code, which
  // matches the doc's ':id' style, so most match. None today, but the
  // set exists as an escape hatch.
]);

describe('W207 api-reference doc → server routes parity', () => {
  it('every curated endpoint listed in /api-reference is registered by a route file', () => {
    const docs: { method: string; path: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = LI_RE.exec(API_REF)) !== null) {
      docs.push({ method: m[1] as string, path: m[2] as string });
    }
    expect(docs.length, 'should find at least one <li>METHOD /v1/...</li>').toBeGreaterThan(10);

    // Normalise path params before comparing. Doc convention is
    // `:id`/`:tier`/`:order_id`; route convention may differ
    // (`:deliveryId` etc.). Replace every `:foo` segment with `:*` on
    // both sides so the comparison is param-name-agnostic.
    const normalise = (p: string): string => p.replace(/:[A-Za-z0-9_]+/g, ':*');
    const NORMALISED_ROUTES = normalise(ROUTES_SOURCE);

    const missing: { method: string; path: string }[] = [];
    for (const { method, path } of docs) {
      if (KNOWN_PARTIAL_PATHS.has(path)) continue;
      const np = normalise(path);
      // Match against any quoted form in the route source.
      const needle = `'${np}'`;
      const altNeedle = `"${np}"`;
      if (!NORMALISED_ROUTES.includes(needle) && !NORMALISED_ROUTES.includes(altNeedle)) {
        missing.push({ method, path });
      }
    }
    expect(
      missing,
      `Doc lists endpoint(s) that aren't registered in apps/server/src/routes/*.ts. ` +
        `Either the doc is stale or the route hasn't shipped yet. ` +
        `Missing:\n${missing.map((e) => `  ${e.method} ${e.path}`).join('\n')}`,
    ).toEqual([]);
  });

  it('pins the shipped archetype, agent collection, and saved-recipe route set', () => {
    for (const endpoint of [
      'GET /v1/archetypes',
      'GET /v1/agent-sessions',
      'GET /v1/agent-sessions/:id/recipe-suggestion',
      'POST /v1/recipes',
      'GET /v1/recipes',
      'GET /v1/recipes/:id',
      'DELETE /v1/recipes/:id',
    ]) {
      expect(API_REF).toContain(`<li>${endpoint}</li>`);
    }
    expect(API_REF).not.toMatch(/\/v1\/recipes\/:id\/(?:execute|replay)/);
  });

  it('W209 — every /v1/... URL mentioned in any /docs/*.astro is a registered route', () => {
    // Walks the entire /docs subdir and asserts each
    // `https://api.driftstack.dev/v1/...` URL maps to a real route.
    // Same normalisation as W208 (param names + id-token wildcards).
    const normalise = (p: string): string =>
      p
        .replace(/:[A-Za-z0-9_]+/g, ':*')
        // Doc id-prefixes (`ses_…`, `prof_…`, …) and the real id
        // prefixes used in publicXxx helpers. Collapse to the same
        // wildcard so they match `:id` in route registrations.
        .replace(/(?:ses|sess|prof|cap|whk|ord|ORD|key|wdl|whd)_[^/?]*/g, ':*')
        .replace(/\/ORD(?:\/|$)/g, '/:*/')
        .replace(/[?…].*$/, '')
        // Strip a trailing slash so e.g. `/v1/billing/crypto-orders/`
        // (left behind when a doc's URL ends in a `${var}` template
        // expression the URL_RE doesn't match) matches the listed
        // route `/v1/billing/crypto-orders`.
        .replace(/\/$/, '');
    const NORMALISED_ROUTES = normalise(ROUTES_SOURCE);

    const URL_RE = /https:\/\/api\.driftstack\.dev(\/v1\/[A-Za-z0-9_/:.…-]+)/g;

    const DOCS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs');
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          out.push(...walk(full));
        } else if (entry.endsWith('.astro')) {
          out.push(full);
        }
      }
      return out;
    }

    const violations: { file: string; path: string }[] = [];
    for (const file of walk(DOCS)) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text)) !== null) {
        const path = m[1] as string;
        const np = normalise(path);
        if (np === '' || np === '/v1') continue;
        const needle = `'${np}'`;
        const altNeedle = `"${np}"`;
        if (!NORMALISED_ROUTES.includes(needle) && !NORMALISED_ROUTES.includes(altNeedle)) {
          violations.push({ file: file.replace(REPO_ROOT + '/', ''), path });
        }
      }
    }
    expect(
      violations,
      `Some doc(s) reference /v1 endpoint(s) the server doesn't register:\n` +
        violations.map((v) => `  ${v.file} → ${v.path}`).join('\n'),
    ).toEqual([]);
  });

  it('W208 — every /v1/... URL mentioned in /docs/api-quickstart is a registered route', () => {
    // The quickstart uses cURL examples with full URL literals like
    // `https://api.driftstack.dev/v1/sessions/sess_…/capture`. Catches
    // the bug class where a snippet references an endpoint that
    // doesn't exist (e.g. the W208 case where `/recording` was
    // documented but never implemented).
    const normalise = (p: string): string =>
      p
        // Collapse Fastify-style `:param` to `:*`.
        .replace(/:[A-Za-z0-9_]+/g, ':*')
        // Collapse documentation-style id placeholders (ses_…, …) to
        // the same wildcard so `ses_…` matches `:id` in the route file.
        .replace(/(?:ses|sess|prof|cap|whk|ord|key|wdl|whd)_[^/?]+/g, ':*')
        // Trim trailing query strings / ellipses we don't want to compare.
        .replace(/[?…].*$/, '');
    const NORMALISED_ROUTES = normalise(ROUTES_SOURCE);

    const URL_RE = /https:\/\/api\.driftstack\.dev(\/v1\/[A-Za-z0-9_/:.…-]+)/g;
    const docPaths = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(API_QUICKSTART)) !== null) {
      docPaths.add(m[1] as string);
    }
    expect(
      docPaths.size,
      'absolute-URL examples found on the page — a drop means the extractor stopped seeing the ' +
        'curl samples, not that the page lost them',
    ).toBeGreaterThanOrEqual(6);

    const missing: string[] = [];
    for (const path of docPaths) {
      const np = normalise(path);
      // Empty path after normalisation is a benign artefact.
      if (np === '' || np === '/v1') continue;
      const needle = `'${np}'`;
      const altNeedle = `"${np}"`;
      if (!NORMALISED_ROUTES.includes(needle) && !NORMALISED_ROUTES.includes(altNeedle)) {
        missing.push(path);
      }
    }
    expect(
      missing,
      `Quickstart references /v1 endpoint(s) the server doesn't register. ` +
        `Missing:\n${missing.map((p) => `  ${p}`).join('\n')}`,
    ).toEqual([]);
  });

  it('CRITICAL every bare `METHOD /v1/path` entry on the page resolves to a registration. The header of this file has always said it parses those entries; until V-1027 it did not — the only matcher here takes absolute `https://api.driftstack.dev/...` URLs, which is six curl samples. The marketing api-reference page lists 88 endpoints that way, and the two bugs this guard was written for (a documented `/v1/billing/checkout` whose route is `checkout-session`, and a `/v1/auth/magic-link` that only exists as `/request` and `/consume`) are exactly that shape: a customer scripting raw HTTP from the listing gets a 404.', () => {
    const ENTRY_RE = /\b(GET|POST|PUT|PATCH|DELETE) (\/v1\/[A-Za-z0-9/_{}:-]+)/g;
    const entries = new Set<string>();
    for (const m of API_REF.matchAll(ENTRY_RE)) {
      entries.add(`${m[1] as string} ${m[2] as string}`);
    }
    expect(
      entries.size,
      'bare METHOD /v1/... entries on the page — a collapse here would make the arm below vacuous',
    ).toBeGreaterThanOrEqual(80);

    const REGISTRATION =
      /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;
    const shape = (p: string): string => p.replace(/\{[^}]+\}|:\w+/g, '{}').replace(/\/+$/, '');
    const registered = new Set<string>();
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
      for (const m of src.matchAll(REGISTRATION)) {
        registered.add(`${(m[1] as string).toUpperCase()} ${shape(m[2] as string)}`);
      }
    }
    expect(registered.size, 'route registrations found').toBeGreaterThanOrEqual(200);

    const unmatched = [...entries]
      .filter((e) => {
        const [verb, path] = e.split(' ') as [string, string];
        return !registered.has(`${verb} ${shape(path)}`);
      })
      .sort();
    expect(
      unmatched,
      'these endpoints are listed on the public API reference but no route registers them — a ' +
        'customer scripting from this page would get a 404:',
    ).toEqual([]);
  });
});
