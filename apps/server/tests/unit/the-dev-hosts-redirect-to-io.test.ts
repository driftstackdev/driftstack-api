// T-3 step 8 — the `.dev` → `.io` redirect middleware must move exactly the six website hosts,
// must never move the API/errors hosts, and must be inert when it does not match.
//
// The middleware is a Cloudflare Pages Function deployed with all five website projects, so it
// executes on every request to every customer-facing site. That makes two properties
// load-bearing and worth pinning: the host map is EXACTLY the six that moved, and the
// non-matching path mutates nothing (no response re-wrapping, no headers) and swallows throws.
//
// Behaviour was verified end-to-end locally against `wrangler pages dev` before shipping — all
// six hosts 301 to their `.io` twin with path and query preserved, `api.`/`errors.`/`.io` hosts
// answer 200, and a project's existing path-based `_redirects` still fire. This file is the
// drift guard for that verified shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MW = resolve(REPO_ROOT, 'functions/_middleware.js');

// The hosts that moved to .io, and the ones that must NEVER move — api./errors. are what the
// SDKs and the RFC-9457 problem-type URIs string-match, and fleet./staging. are internal.
const MOVED_HOSTS = [
  'driftstack.dev',
  'www.driftstack.dev',
  'app.driftstack.dev',
  'docs.driftstack.dev',
  'status.driftstack.dev',
  'admin.driftstack.dev',
] as const;
const NEVER_MOVED = [
  'api.driftstack.dev',
  'errors.driftstack.dev',
  'fleet.driftstack.dev',
  'staging.driftstack.dev',
] as const;

describe('T-3 step 8 — the .dev website hosts redirect to .io', () => {
  it('the middleware ships at the Pages-discovered path', () => {
    expect(existsSync(MW), 'functions/_middleware.js is how wrangler finds it').toBe(true);
  });

  const body = readFileSync(MW, 'utf8');

  it('CRITICAL maps exactly the six website hosts, each to its own .io twin', () => {
    for (const host of MOVED_HOSTS) {
      const twin = host.replace('driftstack.dev', 'driftstack.io');
      expect(body, `${host} → ${twin}`).toContain(`'${host}': '${twin}'`);
    }
    // Exactly six entries — a seventh would move a host nobody decided to move.
    const entries = body.match(/'[a-z.]*driftstack\.dev':/g) ?? [];
    expect(entries).toHaveLength(MOVED_HOSTS.length);
  });

  it('CRITICAL never maps the API, errors, fleet or staging hosts', () => {
    for (const host of NEVER_MOVED) {
      expect(body, `${host} must not appear as a redirect source`).not.toContain(`'${host}':`);
    }
  });

  it('CRITICAL redirects permanently, forces https, and preserves path + query via URL', () => {
    expect(body).toMatch(/Response\.redirect\(url\.toString\(\), 301\)/);
    expect(body).toMatch(/url\.protocol = 'https:';/);
    // hostname is swapped on the parsed URL, which carries pathname + search unchanged —
    // the desktop CLI-authorize flow depends on the query surviving.
    expect(body).toMatch(/url\.hostname = to;/);
  });

  it('CRITICAL the non-matching path is INERT — it swallows throws and returns next() untouched', () => {
    // No response re-wrapping and no header mutation on the pass-through: this runs on every
    // request to five production sites, so a miss must cost nothing and break nothing.
    expect(body).toMatch(/catch \{[\s\S]*?\}\s*return context\.next\(\);/);
    expect(body).not.toMatch(/new Response\(res\.body/);
    expect(body).not.toMatch(/headers\.set\(/);
  });
});
