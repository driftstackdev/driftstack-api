// Cross-source invariant: for every route whose handler BLOCKS on a fleet-node
// round-trip, the timeouts along the whole request chain must be strictly
// ordered, outermost-longest:
//
//     handler budget  <  nginx proxy_read_timeout  <  desktop client deadline  <  Cloudflare
//
// Why this file exists — a real production defect that three careful reviews
// missed because each looked at only two of the four layers.
//
// `apps/gui-client/src/lib/account-proxies.ts` carries this warning above the
// desktop deadline, written when it was raised 30s → 90s:
//
//     "Keep this ABOVE the control plane's fleet wait. If the server's wait ever
//      exceeds this, the bug returns in full and looks exactly like a server fault."
//
// That reasoning was right and the fix was right, but the chain has FOUR layers
// and only two were measured. A VPN row's probe is allowed 80s by the control
// plane (the node's published 70s budget + 10s slack), and the desktop waits 90s
// for it — yet nginx's catch-all `location /` gave up at 60s and returned its own
// 504 HTML. So a tunnel that was merely SLOW to come up (WireGuard: up to 12s for
// the utun device, up to 15s for the handshake poll, then the QUIC leg's 20s
// ceiling, a teardown and two post-tunnel exit fetches) died at a wall that sat
// BETWEEN the two layers everyone had reconciled. The customer saw a generic
// gateway failure for a proxy nobody had finished measuring — which is exactly
// the symptom the 30s → 90s fix was made to kill, relocated one layer inward.
//
// The lesson is not "60s was too small". It is that an ordering invariant held
// between two layers proves nothing about a layer neither of them names, and a
// comment asserting the ordering is not a check. This file is that check: it
// parses the SHIPPED nginx config the same way nginx resolves a location, so the
// relationship is a fact the suite re-derives rather than a claim someone wrote
// down once.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PROBE_EGRESS_REQUEST_TIMEOUT_MS,
  VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS,
} from '../../src/services/probe-egress-request-correlator.js';
import { TRIM_PROFILE_REQUEST_TIMEOUT_MS } from '../../src/services/trim-profile-request-correlator.js';
import { NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS } from '../../src/services/navigate-history-request-correlator.js';
import { UPLOAD_REQUEST_TIMEOUT_MS } from '../../src/services/upload-request-correlator.js';
import {
  DOWNLOAD_LIST_REQUEST_TIMEOUT_MS,
  DOWNLOAD_REQUEST_TIMEOUT_MS,
} from '../../src/services/download-request-correlator.js';
import { COOKIES_REQUEST_TIMEOUT_MS } from '../../src/services/cookies-request-correlator.js';
import { SET_COOKIES_REQUEST_TIMEOUT_MS } from '../../src/services/set-cookies-request-correlator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PROD_CONF = resolve(REPO_ROOT, 'infra/nginx/api.driftstack.dev.conf');
const STAGING_CONF = resolve(REPO_ROOT, 'infra/nginx/staging.driftstack.dev.conf');
const GUI_PROXIES = resolve(REPO_ROOT, 'apps/gui-client/src/lib/account-proxies.ts');

/**
 * Cloudflare fronts api.driftstack.dev (the apex resolves into Cloudflare's
 * proxy range), and on every non-Enterprise plan it emits a 524 after 100s.
 * Nothing in this repo can raise it, so it is the outermost wall: every layer
 * inside it must finish first or the customer gets Cloudflare's error page
 * instead of ours.
 */
const CLOUDFLARE_524_MS = 100_000;

/** nginx's clock starts when it finishes sending the request; a handler's own
 *  correlator timer starts only after auth, the ownership lookup and the relay
 *  reservation. That pre-correlator work is what this margin buys — without it
 *  the two deadlines race and nginx, having started earlier, always wins. */
const MIN_MARGIN_MS = 5_000;

interface Location {
  /** The raw nginx location value, e.g. `/`, `= /v1/fleet/events`, `~ ^/x$`. */
  readonly raw: string;
  readonly kind: 'exact' | 'regex' | 'prefix';
  readonly pattern: string;
  readonly readTimeoutMs: number;
}

/**
 * Parse the `location` blocks of the LAST `server { … }` block in an nginx conf
 * (these files put the :80 redirect first and the real :443 vhost second) and
 * record each one's `proxy_read_timeout`.
 *
 * Deliberately brace-counted rather than regex-sliced: a `location` block's body
 * is what carries the timeout, and a flat regex would happily attribute one
 * block's timeout to another.
 */
function parseLocations(conf: string): Location[] {
  const serverStarts = [...conf.matchAll(/^\s*server\s*\{/gm)].map((m) => m.index ?? 0);
  const lastServer = serverStarts.at(-1);
  expect(lastServer, 'conf should declare at least one server block').not.toBeUndefined();
  const body = conf.slice(lastServer ?? 0);

  const out: Location[] = [];
  const locRe = /^\s*location\s+([^{]+?)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(body)) !== null) {
    const raw = (m[1] ?? '').trim();
    // Walk braces from the opening one to find this block's own extent.
    let depth = 0;
    let i = body.indexOf('{', m.index);
    const start = i;
    for (; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const block = body.slice(start, i + 1);
    const t = /proxy_read_timeout\s+(\d+)s\s*;/.exec(block);
    // A location with no proxy_read_timeout (e.g. a bare `return 200`) inherits
    // nginx's 60s default; recording that is more honest than skipping it.
    const readTimeoutMs = t === null ? 60_000 : Number(t[1]) * 1000;

    if (raw.startsWith('= '))
      out.push({ raw, kind: 'exact', pattern: raw.slice(2).trim(), readTimeoutMs });
    else if (raw.startsWith('~* '))
      out.push({ raw, kind: 'regex', pattern: raw.slice(3).trim(), readTimeoutMs });
    else if (raw.startsWith('~ '))
      out.push({ raw, kind: 'regex', pattern: raw.slice(2).trim(), readTimeoutMs });
    else out.push({ raw, kind: 'prefix', pattern: raw, readTimeoutMs });
  }
  return out;
}

/**
 * Resolve a path the way nginx does: exact (`=`) matches win outright, then
 * regex locations in FILE ORDER (first match wins), then the longest prefix.
 *
 * Getting this order wrong is the failure mode this whole file guards against
 * in miniature — a resolver that always answered "location /" would report the
 * catch-all's timeout for every route and pass or fail uniformly, saying nothing
 * about any individual one. The positive controls below pin the order.
 */
function resolveLocation(locations: readonly Location[], path: string): Location {
  const exact = locations.find((l) => l.kind === 'exact' && l.pattern === path);
  if (exact !== undefined) return exact;

  const rx = locations.find((l) => l.kind === 'regex' && new RegExp(l.pattern).test(path));
  if (rx !== undefined) return rx;

  const prefixes = locations
    .filter((l) => l.kind === 'prefix' && path.startsWith(l.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  const best = prefixes[0];
  if (best === undefined) throw new Error(`no nginx location matches ${path}`);
  return best;
}

/** A concrete request path — the invariant is about what a customer actually
 *  sends, not about the `:id` template, so every sample carries a real-shaped id. */
const ID = '11111111-2222-3333-4444-555555555555';

interface BlockingRoute {
  readonly name: string;
  readonly path: string;
  readonly handlerMs: number;
  readonly why: string;
}

const BLOCKING_ROUTES: readonly BlockingRoute[] = [
  {
    name: 'POST /v1/account/me/proxies/:id/test (VPN row, fleet vantage)',
    path: `/v1/account/me/proxies/${ID}/test`,
    handlerMs: VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS,
    why: "the node's published 70s bring-up budget plus 10s slack; it is the longest blocking wait we ship",
  },
  {
    name: 'POST /v1/account/me/proxies/:id/test (socks5 row, fleet vantage)',
    path: `/v1/account/me/proxies/${ID}/test`,
    handlerMs: PROBE_EGRESS_REQUEST_TIMEOUT_MS,
    why: 'the socks5 tier of the same route',
  },
  {
    name: 'POST /v1/profiles/:id/trim',
    path: `/v1/profiles/${ID}/trim`,
    handlerMs: TRIM_PROFILE_REQUEST_TIMEOUT_MS,
    why: 'relays a trimProfile to the node holding the sealed profile and awaits trimResult',
  },
  {
    name: 'POST /v1/agent-sessions/:id/history',
    path: `/v1/agent-sessions/${ID}/history`,
    handlerMs: NAVIGATE_HISTORY_REQUEST_TIMEOUT_MS,
    why: 'steps the live back-forward list and awaits navigateHistoryResult',
  },
  {
    name: 'POST /v1/agent-sessions/:id/upload',
    path: `/v1/agent-sessions/${ID}/upload`,
    handlerMs: UPLOAD_REQUEST_TIMEOUT_MS,
    why: 'relays file bytes into the session upload jail and awaits uploadResult',
  },
  {
    name: 'GET /v1/agent-sessions/:id/downloads/content',
    path: `/v1/agent-sessions/${ID}/downloads/content`,
    handlerMs: DOWNLOAD_REQUEST_TIMEOUT_MS,
    why: 'pulls a downloaded file back through the node',
  },
  {
    name: 'GET /v1/agent-sessions/:id/downloads',
    path: `/v1/agent-sessions/${ID}/downloads`,
    handlerMs: DOWNLOAD_LIST_REQUEST_TIMEOUT_MS,
    why: 'lists the session download jail',
  },
  {
    name: 'GET /v1/agent-sessions/:id/cookies',
    path: `/v1/agent-sessions/${ID}/cookies`,
    handlerMs: COOKIES_REQUEST_TIMEOUT_MS,
    why: 'pulls the live cookie jar',
  },
  {
    name: 'POST /v1/agent-sessions/:id/cookies',
    path: `/v1/agent-sessions/${ID}/cookies`,
    handlerMs: SET_COOKIES_REQUEST_TIMEOUT_MS,
    why: 'pushes a cookie jar into the live session',
  },
];

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

/** Scrape a `const NAME = 12_345;` literal. Asserted non-null at the call site:
 *  a regex that stops matching after a rename would otherwise turn this whole
 *  file green by measuring nothing. */
function scrapeMs(src: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9_]+);`).exec(src);
  const literal = m?.[1];
  expect(literal, `${name} should still be declared as a plain ms literal`).not.toBeUndefined();
  return Number((literal ?? '0').replace(/_/g, ''));
}

describe('edge timeout vs handler budget — cross-source invariant', () => {
  const prod = parseLocations(readText(PROD_CONF));
  const staging = parseLocations(readText(STAGING_CONF));
  const gui = readText(GUI_PROXIES);

  describe('the nginx location resolver itself (positive controls)', () => {
    it('resolves the long-lived fleet WebSocket to its own exact location, not the catch-all', () => {
      const loc = resolveLocation(prod, '/v1/fleet/events');
      expect(loc.kind).toBe('exact');
      expect(loc.readTimeoutMs).toBe(3_600_000);
    });

    it('resolves a transcript path to the regex location, not the catch-all', () => {
      const loc = resolveLocation(prod, `/v1/agent-sessions/${ID}/transcript`);
      expect(loc.kind).toBe('regex');
    });

    it('falls back to the catch-all for an ordinary route', () => {
      const loc = resolveLocation(prod, '/v1/account/me');
      expect(loc.kind).toBe('prefix');
      expect(loc.pattern).toBe('/');
    });

    it('reads a DIFFERENT timeout for at least two locations', () => {
      // Without this, a parser that attributed one block's timeout to every
      // location would satisfy every arm below by making them all agree.
      expect(new Set(prod.map((l) => l.readTimeoutMs)).size).toBeGreaterThan(1);
    });
  });

  describe('every blocking relay route finishes before the edge gives up', () => {
    for (const route of BLOCKING_ROUTES) {
      it(`${route.name} — handler budget < nginx proxy_read_timeout`, () => {
        const loc = resolveLocation(prod, route.path);
        expect(
          loc.readTimeoutMs,
          `${route.name} waits ${route.handlerMs}ms (${route.why}) but nginx location "${loc.raw}" ` +
            `gives up after ${loc.readTimeoutMs}ms, so the customer gets nginx's 504 instead of the ` +
            `discriminated body this route builds. Give the route a location whose proxy_read_timeout ` +
            `exceeds the handler budget by at least ${MIN_MARGIN_MS}ms.`,
        ).toBeGreaterThanOrEqual(route.handlerMs + MIN_MARGIN_MS);
      });
    }

    it('staging agrees with prod for the longest blocking route', () => {
      // Staging is where a VPN change is exercised first; if its edge is shorter
      // the rehearsal fails in a way prod would not, and the difference reads as
      // a code fault.
      const loc = resolveLocation(staging, `/v1/account/me/proxies/${ID}/test`);
      expect(loc.readTimeoutMs).toBeGreaterThanOrEqual(
        VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS + MIN_MARGIN_MS,
      );
    });
  });

  describe('the desktop client outlasts the edge, and the edge outlasts nothing it cannot', () => {
    it('the fleet proxy-test deadline exceeds the nginx timeout for that route', () => {
      const clientMs = scrapeMs(gui, 'FLEET_PROXY_TEST_DEADLINE_MS');
      const loc = resolveLocation(prod, `/v1/account/me/proxies/${ID}/test`);
      expect(
        clientMs,
        'the desktop must still be listening when nginx answers, or it invents "the server did not ' +
          'answer" for a request the edge already labelled',
      ).toBeGreaterThanOrEqual(loc.readTimeoutMs + MIN_MARGIN_MS);
    });

    it('the fleet proxy-test deadline still fits inside the Cloudflare 524 wall', () => {
      const clientMs = scrapeMs(gui, 'FLEET_PROXY_TEST_DEADLINE_MS');
      expect(
        clientMs,
        'past this, Cloudflare answers before the desktop does and no layer we own is heard',
      ).toBeLessThan(CLOUDFLARE_524_MS);
    });

    it('the whole chain for the longest route is strictly ordered', () => {
      const clientMs = scrapeMs(gui, 'FLEET_PROXY_TEST_DEADLINE_MS');
      const edgeMs = resolveLocation(prod, `/v1/account/me/proxies/${ID}/test`).readTimeoutMs;
      const chain = [VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS, edgeMs, clientMs, CLOUDFLARE_524_MS];
      expect(chain, 'handler < nginx < desktop < Cloudflare').toEqual(
        [...chain].sort((a, b) => a - b),
      );
      expect(
        new Set(chain).size,
        'no two layers may tie — a tie is a race the inner layer loses',
      ).toBe(chain.length);
    });
  });
});
