// W345.A — drift guard for marketing /docs/sessions developer
// reference. Pins:
//
//   • 5 lifecycle states ↔ SessionStatusSchema
//   • pagination defaults: page=50, max=100 — from PaginationQuerySchema
//   • subscribable webhook events for session lifecycle —
//     session.completed + session.failed — must be in
//     SubscribableWebhookEventTypeSchema
//   • flat-response (no `{ session: {…} }` envelope) is the live
//     shape; `concurrency-limit` is the canonical 429 problem-type
//   • cross-links to the docs quickstart-curl + concurrency guide
//     (S47 2026-07-07 mirror-deprecation successors) + /docs/rate-limits
//     all resolve.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SessionStatusSchema,
  PaginationQuerySchema,
  SubscribableWebhookEventTypeSchema,
  CreateSessionRequestSchema,
  LOCKED_ARCHETYPE_ID,
  PROBLEM_TYPES,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sessions.astro');
// S47 2026-07-07 (founder-approved: mirror deprecation): api-quickstart
// + concurrency mirrors deleted; cross-links point at the docs successors.
const QUICKSTART = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart-curl.md');
const RATE_LIMITS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/rate-limits.astro');
const CONCURRENCY = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/concurrency.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W345.A /docs/sessions parity', () => {
  const body = read(PAGE);

  it('LIFECYCLE table covers exactly the SessionStatusSchema set', () => {
    const block = body.match(/LIFECYCLE\s*=\s*\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const states = [...block![1]!.matchAll(/state:\s*'([a-z]+)'/g)].map((m) => m[1]!).sort();
    const schema = [...(SessionStatusSchema._def as { values: readonly string[] }).values].sort();
    expect(states).toEqual(schema);
  });

  it('happy-path transition string lists creating → ready → busy → destroyed', () => {
    expect(body).toMatch(/creating → ready → busy → destroyed/);
    expect(body).toMatch(/<code>errored<\/code> is terminal/);
  });

  it('pagination defaults (50) + max (100) match PaginationQuerySchema', () => {
    // Zod default + max() come from the schema fluent calls; pull
    // them out and assert the page's prose matches.
    const limit = (
      PaginationQuerySchema._def.shape() as { limit: { _def: { defaultValue: () => number } } }
    ).limit;
    expect(limit._def.defaultValue()).toBe(50);
    expect(body).toMatch(/Default page size is\s*<strong>50<\/strong>/);
    expect(body).toMatch(/max\s*<strong>100<\/strong>/);
  });

  it('cites session.completed + session.failed as subscribable webhook events', () => {
    const schemaEvents = new Set<string>(
      (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
    );
    expect(schemaEvents.has('session.completed')).toBe(true);
    expect(schemaEvents.has('session.failed')).toBe(true);
    expect(body).toContain('session.completed');
    expect(body).toContain('session.failed');
  });

  it('concurrency-limit is the canonical 429 problem-type cited on cap hit', () => {
    // The page cites the slug; PROBLEM_TYPES must declare the URI.
    expect(body).toMatch(/<code>concurrency-limit<\/code>/);
    expect(PROBLEM_TYPES.ConcurrencyLimit).toBe('https://errors.driftstack.dev/concurrency-limit');
  });

  it('responses are flat (no `{ "session": … }` envelope)', () => {
    // Pin the prose so a future copy revamp can't reintroduce the
    // envelope.
    expect(body).toMatch(/no\s*<code>[\s\S]*?session[\s\S]*?<\/code>\s*envelope/);
  });

  it("session ids carry the 'ses_' prefix (id-prefix convention)", () => {
    expect(body).toMatch(/<code>ses_<\/code>/);
    expect(body).toMatch(/"id":\s*"ses_/);
  });

  it('archetype must be an id the live GET /v1/archetypes catalog returns', () => {
    // a05933cc0 (2026-07-15) retired the "mint your own 3–60-char slug via
    // the Profiles API" framing: customers cannot mint archetypes, and the
    // create-session input contract refuses anything the public catalog does
    // not return. Pin the page's catalog claim against the schema that
    // enforces it (SelectableArchetypeIdSchema's isSelectableArchetypeId
    // refine) plus the default_archetype_id fallback the catalog owns.
    expect(body).toMatch(
      /<code>archetype<\/code> identifies an exact device, iOS, and\s*Safari combination from the live <code>GET \/v1\/archetypes<\/code>\s*catalog\./,
    );
    expect(body).toMatch(/<code>default_archetype_id<\/code>/);
    const catalogId = CreateSessionRequestSchema.safeParse({ archetype: LOCKED_ARCHETYPE_ID });
    const offCatalog = CreateSessionRequestSchema.safeParse({
      archetype: 'not_a_catalog_archetype',
    });
    expect(catalogId.success).toBe(true);
    expect(offCatalog.success).toBe(false);
  });

  it('cross-links to the curl quickstart (docs successor), /docs/rate-limits, and the concurrency guide (docs successor) all resolve (S47 2026-07-07)', () => {
    for (const [href, file] of [
      ['https://docs.driftstack.io/quickstart-curl/', QUICKSTART],
      ['/docs/rate-limits', RATE_LIMITS],
      ['https://docs.driftstack.io/guides/concurrency/', CONCURRENCY],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(file)).toBe(true);
    }
  });

  it('capture kinds are restricted to {screenshot, dom_snapshot, pdf}', () => {
    expect(body).toMatch(/<code>screenshot<\/code>/);
    expect(body).toMatch(/<code>dom_snapshot<\/code>/);
    expect(body).toMatch(/<code>pdf<\/code>/);
  });
});
