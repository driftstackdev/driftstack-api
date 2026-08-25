// V-1599 — a gui_control_key reaches a set of routes with NO scope check of its
// own. That set must stay inside what minting the key already required.
//
// The mechanism, quoted from the route that mints it: "Every
// controlKeyOrAccountAuth route `return`s on a valid control key BEFORE
// `app.requireScope(requiredScope)` runs, so whatever the key reaches, it reaches
// with no scope check at all." The scope named in
// `controlKeyOrAccountAuth('read:sessions')` is what an ORDINARY key needs on the
// fallback path; a control key skips it.
//
// So the only thing standing between a control key and a route is the mint. That
// gate is `requireScope('write')` + `requireScope('read:sessions')`, and audit
// wxzlp9yiz records why both are there rather than one: with only `write`, a
// bare-write key — refused those reads directly — could mint its way into the
// live cookie jar, page state and downloaded bytes; with only `read`, a read-only
// key could escalate to mode/input/takeover/handback and DELETE. The original
// rationale reasoned about read→write and missed write→read.
//
// That reasoning is only sound while the reachable set stays inside the minted
// set. Add `controlKeyOrAccountAuth('admin:profiles')` tomorrow and a key minted
// with write + read:sessions reaches an admin-profiles route having proven
// neither — the same P1 in a new place, and nothing in the suite would say so.
//
// Both sides are derived. Neither is a list kept here, because a list is what
// stops being read.
//
// Measured when this landed: reached {read:sessions, write} across 14
// registrations — five reads (GET /:id, page-state, cookies, downloads,
// downloads/content) and nine writes — against a mint requiring
// {read:sessions, write}. Equal today; the assertion is subset, because requiring
// MORE at the mint than the key can reach is a tightening, not a hole.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_SESSIONS = resolve(HERE, '..', '..', 'src', 'routes', 'agent-sessions.ts');

/** Cut `//` to end of line, leaving string literals alone. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      let out = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i] as string;
        if (quote !== null) {
          out += ch;
          if (ch === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          out += ch;
          continue;
        }
        if (ch === '/' && line[i + 1] === '/') break;
        out += ch;
      }
      return out;
    })
    .join('\n');
}

/** Scopes a control key can reach without proving them. */
function scopesReached(code: string): { scopes: string[]; sites: number } {
  const hits = [...code.matchAll(/controlKeyOrAccountAuth\(\s*'([a-z_:]+)'\s*\)/g)];
  return { scopes: [...new Set(hits.map((m) => m[1] as string))].sort(), sites: hits.length };
}

/** Scopes the mint itself demands, read from its own preHandler block. */
function scopesRequiredToMint(code: string): string[] {
  const at = code.indexOf("'/v1/agent-sessions/:id/gui-control-key'");
  expect(at, 'the mint route is still registered at a literal path').toBeGreaterThan(0);
  // The preHandler array is the first one after the path literal.
  const open = code.indexOf('preHandler: [', at);
  expect(open, 'the mint still declares a preHandler array').toBeGreaterThan(at);
  const close = code.indexOf(']', open);
  const block = code.slice(open, close);
  const hits = [...block.matchAll(/requireScope\(\s*'([a-z_:]+)'\s*\)/g)];
  return [...new Set(hits.map((m) => m[1] as string))].sort();
}

describe('a control key reaches nothing its mint does not require', () => {
  it('CRITICAL both sides parsed a real population. A subset assertion is satisfied by an empty left-hand side, and this file would then pass while saying nothing — which is the failure mode it exists to prevent elsewhere.', () => {
    const code = codeOf(readFileSync(AGENT_SESSIONS, 'utf8'));
    const reached = scopesReached(code);
    expect(reached.scopes, 'control-key-reachable scopes were found').not.toEqual([]);
    expect(
      reached.sites,
      'the fourteen session-scoped registrations are still being seen',
    ).toBeGreaterThanOrEqual(10);
    expect(scopesRequiredToMint(code), 'the mint still names the scopes it demands').not.toEqual(
      [],
    );
  });

  it('CRITICAL every scope a control key reaches is one the mint already demanded. A control key skips requireScope on the routes it reaches, so the mint is the only gate; a reachable scope outside the minted set is audit wxzlp9yiz reopened in a new place — a key that proves write + read:sessions and then reaches something it proved neither for.', () => {
    const code = codeOf(readFileSync(AGENT_SESSIONS, 'utf8'));
    const minted = new Set(scopesRequiredToMint(code));
    const escapes = scopesReached(code).scopes.filter((s) => !minted.has(s));
    expect(
      escapes,
      'these are reachable with a control key that never proved them at the mint',
    ).toEqual([]);
  });
});
