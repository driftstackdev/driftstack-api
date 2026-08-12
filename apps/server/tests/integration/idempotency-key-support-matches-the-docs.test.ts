// The endpoints that honour `Idempotency-Key` are exactly the ones the
// customer documentation says honour it.
//
// This is a docs-to-server invariant, not a docs-to-docs one, and the
// distinction is the point. A parity pin records what the text SAID; it cannot
// tell whether the text was TRUE. Five customer-facing pages told readers to
// "send an Idempotency-Key header on create-style POSTs" so that "a network
// retry replays the original response instead of minting a duplicate session".
// Measured against the running server, 41 of 45 POST endpoints ignore the
// header outright — including `POST /v1/sessions`, the create-style POST those
// very quickstarts teach two sections earlier.
//
// The cost of that gap is real money and a wedged account: a customer whose
// `sessions.create()` times out retries with the same key, believing the
// original response will replay, and mints a SECOND concurrent session. Free
// tier allows one, API Starter two. The duplicate consumes a slot and the next
// call gets a 429 the customer cannot explain.
//
// The honoured set is READ OUT OF THE DOCS PAGE rather than pinned here, so
// this cannot drift into agreeing with itself. Wiring a new route to the header
// without documenting it fails, and documenting one that was never wired fails
// too. A list maintained in the test would only ever prove the test agrees with
// the test.
//
// Detection is by the rejection NAMING the header. An invalid key (whitespace
// inside) is a 400 from every honouring route, and the message says
// `Idempotency-Key` — a route that never reads the header cannot produce that
// string. Comparing status alone does not work: most of these endpoints 400 on
// the payload anyway, which masks the difference entirely, and comparing whole
// bodies is worse because responses carry per-request ids.
//
// Two of the four validate the request body BEFORE reading the header, so an
// empty payload masks them and they need a valid one to observe. That ordering
// is deliberate, not a defect — the message route's own comment says invalid
// requests "must not poison the account's durable idempotency namespace" — so
// the probe supplies real payloads for those two rather than treating them as
// unobservable.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_PAGE = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'src',
  'pages',
  'reference',
  'idempotency.md',
);

/** A key with whitespace inside — invalid under the documented contract. */
const INVALID_KEY = 'has a space';

/**
 * Bodies the two payload-first routes need before the header is ever read.
 *
 * Deliberately minimal and stated per route, because each entry is a place the
 * probe stops deriving from the server and starts trusting me. A stale entry
 * shows up as its route dropping out of the honoured set, which fails.
 */
const PAYLOADS: Record<string, Record<string, unknown>> = {
  'POST /v1/agent-sessions/{id}/message': { user_message: 'ping' },
  'POST /v1/billing/crypto-checkout': {
    product: 'api_starter',
    price_cents: 1000,
    price_currency: 'USD',
  },
};

/** The endpoints the customer docs promise honour the header. */
function documentedEndpoints(): string[] {
  const page = readFileSync(DOCS_PAGE, 'utf8');
  const start = page.indexOf('honoured on these explicitly wired endpoints');
  if (start < 0) return [];
  // The bullet list runs until the paragraph that starts "Every other endpoint".
  const end = page.indexOf('Every other endpoint', start);
  const block = page.slice(start, end < 0 ? start + 1200 : end);
  return [...block.matchAll(/^-\s+`(POST [^`]+)`/gm)].map((m) => m[1]!).sort();
}

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: { paths?: Record<string, Record<string, unknown>> };
const honours: string[] = [];
const ignores: string[] = [];

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json();
  const auth = { authorization: `Bearer ${fx.plaintext}` };

  // One real agent session, so the templated message route is reachable with
  // an id the server actually issued rather than a synthetic one.
  const created = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: auth,
    payload: {},
  });
  const agentId = created.statusCode === 201 ? (created.json<{ id?: string }>().id ?? '') : '';

  const targets: { op: string; url: string }[] = [];
  for (const path of Object.keys(spec.paths ?? {})) {
    if (!path.startsWith('/v1/') || path.includes('{')) continue;
    if (spec.paths?.[path]?.['post'] === undefined) continue;
    if (!fx.app.hasRoute({ method: 'POST', url: path })) continue;
    targets.push({ op: `POST ${path}`, url: path });
  }
  if (agentId !== '') {
    targets.push({
      op: 'POST /v1/agent-sessions/{id}/message',
      url: `/v1/agent-sessions/${agentId}/message`,
    });
  }

  for (const { op, url } of targets) {
    const res = await fx.app.inject({
      method: 'POST',
      url,
      headers: { ...auth, 'idempotency-key': INVALID_KEY },
      payload: PAYLOADS[op] ?? {},
    });
    // Only a route that READ the header can name it back.
    if (res.body.includes('Idempotency-Key')) honours.push(op);
    else ignores.push(op);
  }
  honours.sort();
  ignores.sort();
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('Idempotency-Key support matches what the docs promise', () => {
  it('CRITICAL the probe reached a real population AND can actually detect support. An empty honoured set would satisfy the comparison below only if the docs were also empty, so both sides are floored — a probe that detected nothing must not read as "the docs are accurate".', () => {
    expect(honours.length + ignores.length, 'POST endpoints probed').toBeGreaterThanOrEqual(40);
    expect(honours.length, 'endpoints observed honouring the header').toBeGreaterThanOrEqual(4);
    expect(documentedEndpoints().length, 'endpoints the docs page lists').toBeGreaterThanOrEqual(4);
    // The detector must also be able to say NO, or "everything honours it"
    // would pass the same way.
    expect(ignores.length, 'endpoints observed ignoring the header').toBeGreaterThanOrEqual(30);
  });

  it('CRITICAL the endpoints that honour the header are EXACTLY the ones the docs list. Read from apps/docs/src/pages/reference/idempotency.md at runtime, so wiring a route without documenting it fails, and documenting one that was never wired fails too.', () => {
    expect(honours, 'runtime support vs the published list:').toEqual(documentedEndpoints());
  });

  it('CRITICAL every docs page that mentions the header links to the page that scopes it. The five false claims were all pages describing scope in ISOLATION — "send it on create-style POSTs" reads as universal, and a reader had no reason to look further. One authoritative list, always one click away, is what makes a local mention safe.', () => {
    const pagesDir = resolve(DOCS_PAGE, '..', '..');
    const mentions: string[] = [];
    const unlinked: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|mdx|astro)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        if (!text.includes('Idempotency-Key')) continue;
        // The reference page is exempt because it IS the destination —
        // derived from the path rather than kept as a name in a list, so the
        // exemption cannot outlive the page.
        if (full === DOCS_PAGE) continue;
        mentions.push(full);
        if (!text.includes('/reference/idempotency')) unlinked.push(full.slice(pagesDir.length));
      }
    };
    walk(pagesDir);
    expect(mentions.length, 'docs pages mentioning the header').toBeGreaterThanOrEqual(8);
    expect(unlinked.sort(), 'page(s) describing the header with no link to its scope:').toEqual([]);
  });

  it('CRITICAL POST /v1/sessions does NOT honour the header, and the docs must not imply otherwise. It is the create-style POST every quickstart teaches, and five pages advised sending the header there — a retry after a timeout mints a SECOND concurrent session, consuming a tier slot (Free: 1) and 429ing the next call.', () => {
    expect(ignores, 'POST /v1/sessions must be observed ignoring the header').toContain(
      'POST /v1/sessions',
    );
    expect(honours, 'and must never appear as honouring it').not.toContain('POST /v1/sessions');
  });
});
