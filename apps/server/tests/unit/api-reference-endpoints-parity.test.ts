// W207 — drift guard between the customer-facing /api-reference page
// and the actual Fastify route registrations.
//
// Background: api-reference.astro lists every endpoint as a quick
// nav cue (`GET /v1/sessions`, `POST /v1/billing/checkout-session`).
// Two earlier bugs found in this audit: the doc listed
// `/v1/billing/checkout` (real route: `/v1/billing/checkout-session`)
// and `/v1/auth/magic-link` (real routes are `magic-link/request` and
// `magic-link/consume`). Customers reading the doc to script raw
// HTTP calls would hit 404s.
//
// This guard parses the doc's `<li>METHOD /v1/...</li>` entries and
// asserts each one appears as a string literal in some
// `apps/server/src/routes/*.ts` file. The check is intentionally
// loose: substring match against the route literal, so we tolerate
// Fastify type-parameter sugar like `app.post<{...}>('/v1/...', …)`.

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
// docs.driftstack.dev/quickstart-curl/), so this guard now scans the
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
  it('every endpoint listed in /api-reference is registered by a route file', () => {
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
    expect(docPaths.size, 'should find at least one /v1 URL').toBeGreaterThan(0);

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
});
