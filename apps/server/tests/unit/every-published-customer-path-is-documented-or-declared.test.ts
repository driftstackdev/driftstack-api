// V-847 — a customer-facing path in the published spec that no documentation
// mentions is a gap; it should be a recorded one.
//
// `packages/sdk-python/openapi.json` ships inside the Python SDK and drives
// spec-consuming tooling. V-824 already found it carrying three admin-oauth
// paths that a source comment claimed were withheld. This is the other
// direction: paths the spec publishes to customers that the customer docs never
// mention.
//
// Measured across `apps/docs/src/pages/**`: 164 non-admin operations, and six
// paths mentioned nowhere. None of the six is a defect on its own — that is
// the point of listing them rather than failing on them:
//
//   • `/health` and `/version` are NOT on the list: I exempted them as
//     "operational probes" and the third arm below rejected both on its first
//     run, because `api/status.md` names `/health` and `api/sessions.md` names
//     `/version`. The guard refused its author's own roster before it refused
//     anyone else's, which is the only reason to write that arm.
//   • `/v1/egress/echo`, `/v1/fleet/events` — infrastructure surfaces.
//   • `/v1/sessions/:id/proxy` — undocumented because it does not work; every
//     path through it 503s and V-823 records why.
//   • the three OAuth-CLIENT paths — `/v1/auth/oauth-client/start`,
//     `/v1/auth/oauth-client/confirm-merge`, `/v1/account/me/oauth-links`.
//     `api/oauth.md` documents Driftstack as an OAuth PROVIDER; the
//     sign-in-with-Google/GitHub CLIENT flow is a different feature and has no
//     page. The first two are consumed by the dashboard SPA rather than by
//     customer code; `oauth-links` takes a `read` scope and is callable by
//     anyone with a key.
//
// This file does NOT write those pages. Deciding which of these belong in
// customer documentation is an audience question — publishing an SPA-internal
// auth step as a customer endpoint is a choice, and so is withholding a
// readable one. What it does is stop the list growing without anyone noticing,
// which is how the current six got here.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages');

/**
 * Published customer paths that no customer page mentions, each with the reason
 * it is acceptable today. An entry is a statement that somebody decided, not
 * that documenting it was inconvenient.
 */
const UNDOCUMENTED_BY_DESIGN: Record<string, string> = {
  '/v1/egress/echo': 'infrastructure diagnostic for the egress path',
  '/v1/fleet/events': 'fleet control-plane surface, not customer-facing',
  '/v1/sessions/:id/proxy':
    'every path through it 503s — the route layer is not wired to the egress service (V-823). ' +
    'Documenting it would advertise a feature that cannot be used.',
  '/v1/auth/oauth-client/start':
    'sign-in-with-Google/GitHub step consumed by the dashboard SPA, not by customer code. ' +
    'api/oauth.md documents Driftstack as an OAuth PROVIDER; the CLIENT flow has no page.',
  '/v1/auth/oauth-client/confirm-merge': 'same SPA-internal client flow as oauth-client/start',
  '/v1/agent-sessions/:id/network':
    'GUI-internal DevTools-style network feed for the simulator; consumed by the desktop app ' +
    'over control-key auth, not a customer SDK operation',
};

function normalise(p: string): string {
  return p
    .replace(/\{[^}]+\}/g, ':id')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':id')
    .replace(/\/$/, '');
}

function docsText(): string {
  let out = '';
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(md|astro)$/.test(e.name)) out += `${readFileSync(full, 'utf8')}\n`;
    }
  };
  walk(DOCS);
  return out;
}

function publishedCustomerPaths(): string[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as { paths: Record<string, unknown> };
  return Object.keys(spec.paths)
    .filter((p) => !p.startsWith('/v1/admin/'))
    .map(normalise);
}

describe('V-847 every published customer path is documented or declared', () => {
  it('CRITICAL both sides parse real data. The comparison reports a difference, so an empty spec read or an empty docs read would agree with each other and report full coverage over nothing — the failure mode this sweep kept finding.', () => {
    expect(statSync(SPEC).size, 'spec file read').toBeGreaterThan(1000);
    expect(publishedCustomerPaths().length, 'non-admin paths in the spec').toBeGreaterThan(100);
    expect(docsText().length, 'customer documentation read').toBeGreaterThan(50_000);
  });

  it('CRITICAL every published customer path is either mentioned in the docs or declared here with a reason. The spec ships inside the Python SDK, so a path in it is a path customers can discover and call; if nothing documents it they are on their own. The ones declared today are each defensible; the value is that the next one cannot appear silently.', () => {
    const text = docsText();
    const mentioned = new Set(
      [...text.matchAll(/(\/(?:v1\/)?[A-Za-z0-9_\-/:{}.]+)/g)].map((m) =>
        normalise(m[1] as string),
      ),
    );

    const undocumented = publishedCustomerPaths()
      .filter((p) => !mentioned.has(p))
      .filter((p) => UNDOCUMENTED_BY_DESIGN[p] === undefined)
      .sort();

    expect(
      undocumented,
      'published customer path that no documentation mentions. Either document it, or add it to UNDOCUMENTED_BY_DESIGN with the reason it is acceptable:',
    ).toEqual([]);
  });

  it('CRITICAL every declared exemption is still undocumented, so the list cannot outlive its reasons. A path that HAS been documented must come off — otherwise the roster silently becomes a list of things nobody rechecked, which is the shape V-802 calls a blindfold.', () => {
    const text = docsText();
    const mentioned = new Set(
      [...text.matchAll(/(\/(?:v1\/)?[A-Za-z0-9_\-/:{}.]+)/g)].map((m) =>
        normalise(m[1] as string),
      ),
    );

    const nowDocumented = Object.keys(UNDOCUMENTED_BY_DESIGN).filter((p) => mentioned.has(p));
    expect(
      nowDocumented,
      'these are documented now — delete the exemption so the path is checked normally:',
    ).toEqual([]);
  });
});
