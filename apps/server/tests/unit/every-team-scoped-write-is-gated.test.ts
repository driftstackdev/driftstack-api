// V-1069 — a write that can act on someone else's account must check the role.
//
// V-837 derives the team-role split and asks: is every role check a write gate?
// That catches a gate in the wrong place. It cannot catch a gate that is ABSENT,
// because an absent check contributes nothing to the list it partitions. A new
// route that resolves an effective account and forgets the role check leaves every
// V-837 arm green while a `member` mutates an owner's account.
//
// This is that direction. Measured today: 47 live `/v1` writes resolve an effective
// (team) account, and all 47 carry one of five recognised gates —
//
//     18  effectiveAccountIdForWrite
//     12  callerCanAccessAgentSession
//      8  effectiveAccountIdForLiveOperation
//      6  an inline `role !== 'admin'`
//      3  effectiveAccountIdForKeyWrite
//
// so this file starts green. What it refuses is the forty-eighth.
//
// ── The derived form alone was a false green, and a mutation said so ───────
//
// The first version detected "team-scoped" from the same tokens that count as
// gates. 22 of the 47 writes — every profiles, webhooks and api-keys write — are
// visible ONLY through their gating helper, because that helper is what reads the
// header. Deleting the gate therefore removed the route from the population
// instead of reporting it, and the arm stayed green. That is the exact failure
// this file exists to prevent, wearing a pass as a disguise.
//
// So the population is pinned as well as derived. ROSTER records the gate each
// write carries; the scan recomputes it; the two must agree. Deleting a gate
// changes that route's answer, adding a write puts an unregistered path in the
// scan, and either way somebody has to come here and say which it is.
//
// ── Why the vocabulary is shared, not restated ─────────────────────────────
//
// The helper names are read out of V-837 rather than listed here. Two files each
// holding their own idea of "what counts as a gate" is how one of them silently
// stops counting: a new helper added to that list and not this one would make its
// routes read as ungated here, and added here and not there would let a role check
// hide in a helper V-837 does not know. Reading one list keeps them the same list,
// and an arm below fails if it cannot be found.
//
// ── What this deliberately does not decide ─────────────────────────────────
//
// Whether a given route SHOULD be admin-only is a product question, and V-837 owns
// the read side of it. This asks only whether a write that can reach another
// account's data consults the membership role at all before doing so.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const SPLIT_GUARD = resolve(
  HERE,
  'the-team-role-read-write-split-is-derived-not-described.test.ts',
);

const REGISTRATION =
  /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;

/**
 * Markers that a handler resolves an account other than the caller's own, chosen so
 * that NONE of them is also a gate. A token serving both roles cancels itself: delete
 * the gate and the route stops looking team-scoped.
 */
const SCOPE_MARKERS = [
  'resolveEffectiveAccount',
  'readEffectiveAccountHeader',
  'consumeEffectiveOwnerRateLimit',
] as const;

/** The role-gating helpers, read from V-837 so the two files cannot disagree. */
function gatingHelpers(): string[] {
  const src = readFileSync(SPLIT_GUARD, 'utf8');
  const block = /const ROLE_GATING_HELPERS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
  return [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** A gate is one of those helpers, or the inline role comparison. */
function gatesFor(segment: string): string[] {
  const found = gatingHelpers().filter((h) => segment.includes(h));
  if (/role\s*!==\s*'admin'|role\s*===\s*'admin'/.test(segment)) found.push('inline role check');
  return found;
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly gates: string[];
  /** True when a marker OTHER than the gate itself shows this route is team-scoped. */
  readonly scoped: boolean;
}

/**
 * Every live `/v1` write that can act on another account, and the gate it carries.
 *
 * `inline` means an `effective.role !== 'admin'` comparison in the handler itself.
 */
const ROSTER: Readonly<Record<string, readonly string[]>> = {
  'DELETE /v1/agent-sessions/:id': ['callerCanAccessAgentSession'],
  'DELETE /v1/api-keys/:id': ['effectiveAccountIdForKeyWrite'],
  'DELETE /v1/profile-snapshots/:id': ['effectiveAccountIdForWrite'],
  'DELETE /v1/profiles/:id': ['effectiveAccountIdForWrite'],
  'DELETE /v1/profiles/:id/purge': ['effectiveAccountIdForWrite'],
  'DELETE /v1/sessions/:id': ['inline role check'],
  'DELETE /v1/webhooks/:id': ['effectiveAccountIdForWrite'],
  'PATCH /v1/profiles/:id': ['effectiveAccountIdForWrite'],
  'PATCH /v1/webhooks/:id': ['effectiveAccountIdForWrite'],
  // Two gates, both pinned (V-2164, closing the V-2163 gates[0] weakening): the inline
  // `effective.role` check gates the CREATE; `callerCanAccessAgentSession` gates the
  // `continue_from_agent_session_id` source lookup (V-2161). A future removal of either
  // now fails the "still carries the gate" arm, which compares the full set.
  'POST /v1/agent-sessions': ['callerCanAccessAgentSession', 'inline role check'],
  'POST /v1/agent-sessions/:id/cookies/set': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/files': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/handback': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/history': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/input-event': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/livekit-token': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/mode': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/resume': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/takeover': ['callerCanAccessAgentSession'],
  'POST /v1/agent-sessions/:id/transport-report': ['callerCanAccessAgentSession'],
  'POST /v1/api-keys': ['effectiveAccountIdForKeyWrite'],
  'POST /v1/api-keys/:id/rotate': ['effectiveAccountIdForKeyWrite'],
  'POST /v1/profile-snapshots/:id/restore': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles/:id/clone': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles/:id/launch': ['inline role check'],
  'POST /v1/profiles/:id/restore': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles/:id/snapshots': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles/:id/transfer': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles/:id/trim': ['effectiveAccountIdForWrite'],
  'POST /v1/profiles/import': ['effectiveAccountIdForWrite'],
  'POST /v1/recipes': ['callerCanAccessAgentSession'],
  'POST /v1/sessions': ['inline role check'],
  'POST /v1/sessions/:id/capture': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/extract': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/gui-input': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/interact': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/login': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/navigate': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/search': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/sessions/:id/wait': ['effectiveAccountIdForLiveOperation'],
  'POST /v1/webhook-deliveries/:deliveryId/replay': ['effectiveAccountIdForWrite'],
  'POST /v1/webhooks': ['effectiveAccountIdForWrite'],
  'POST /v1/webhooks/:id/rotate-secret': ['effectiveAccountIdForWrite'],
  'POST /v1/webhooks/:id/test': ['effectiveAccountIdForWrite'],
  'PUT /v1/account/email-preferences': ['inline role check'],
  'PUT /v1/account/me/organization': ['inline role check'],
};

/**
 * Live `/v1` routes whose handler touches an effective account.
 *
 * Segments are bounded by the enclosing `export function` as well as the next
 * registration. Without that bound the last live route in a file swallows the
 * `…DisabledRoutes` stub beneath it and inherits whatever it contains — the
 * overrun this corpus has hit three times.
 */
function teamScopedRoutes(): Route[] {
  const out: Route[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map((m) => [m.index, m[1]!] as const);
    const edges = [...fns.map(([at]) => at), src.length];
    const regs = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of regs.entries()) {
      let owner = '(top)';
      let fnEnd = src.length;
      for (const [idx, [at, name]] of fns.entries()) {
        if (at <= m.index) {
          owner = name;
          fnEnd = edges[idx + 1] ?? src.length;
        } else break;
      }
      if (/Disabled/.test(owner)) continue;
      const nextReg = i + 1 < regs.length ? (regs[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(m.index + m[0].length, Math.min(nextReg, fnEnd));
      const gates = gatesFor(segment);
      const scoped = SCOPE_MARKERS.some((k) => segment.includes(k));
      if (!scoped && gates.length === 0) continue;
      out.push({
        method: (m[1] ?? '').toUpperCase(),
        path: m[2] ?? '',
        file,
        gates,
        scoped,
      });
    }
  }
  return out;
}

const writes = (): Route[] => teamScopedRoutes().filter((r) => r.method !== 'GET');

describe('V-1069 every team-scoped write is gated', () => {
  it('CRITICAL the scan finds real routes and the gate vocabulary loaded. A walk that matched nothing, or a helper list that came back empty, would report every write as ungated or every write as fine depending on which half broke — and the arm below would agree with either.', () => {
    const all = teamScopedRoutes();
    expect(all.length, 'live routes resolving an effective account').toBeGreaterThanOrEqual(60);
    expect(writes().length, 'team-scoped writes').toBeGreaterThanOrEqual(40);

    const helpers = gatingHelpers();
    expect(
      helpers.length,
      'ROLE_GATING_HELPERS could not be read from the V-837 guard — if that file moved or renamed ' +
        'the list, this one is comparing against nothing',
    ).toBeGreaterThanOrEqual(4);
    expect(helpers, 'the shared vocabulary lost the agent-session predicate').toContain(
      'callerCanAccessAgentSession',
    );

    // The detector must distinguish. A route known to be gated reads as gated,
    // and a segment with no gate reads as ungated.
    expect(gatesFor("if (effective.role !== 'admin') throw x;")).toContain('inline role check');
    expect(gatesFor('const id = ctx.account.id;')).toEqual([]);
  });

  it('CRITICAL every write that resolves an effective account through the header consults the membership role. This is the derived half, and it covers routes written in the resolveEffectiveAccount style — the ones whose team-scope survives having their gate deleted.', () => {
    const ungated = writes()
      .filter((r) => r.scoped && r.gates.length === 0)
      .map((r) => `${r.method} ${r.path}  (${r.file})`)
      .sort();
    expect(
      ungated,
      'these writes resolve an effective account with no role gate — add one of the recognised ' +
        'helpers, or an inline admin check:',
    ).toEqual([]);
  });

  it('CRITICAL every registered write still carries the gate it was registered with. The derived arm above cannot see the 22 writes whose only team-scope signal IS their gating helper: deleting it drops them out of the scan rather than flagging them, which a mutation proved by staying green. Comparing against the roster is what makes a deletion visible.', () => {
    // V-2164 — compare the FULL gate SET, sorted, not just gates[0]. A route that
    // carries two gates (e.g. POST /v1/agent-sessions: the inline CREATE check plus
    // the continue-from source lookup) now pins both, so dropping either is caught.
    const found = new Map(
      writes().map((r) => [`${r.method} ${r.path}`, [...r.gates].sort().join(' + ') || 'NONE']),
    );
    const drifted: string[] = [];
    for (const [route, expected] of Object.entries(ROSTER)) {
      const want = [...expected].sort().join(' + ');
      const actual = found.get(route);
      if (actual === undefined) drifted.push(`${route}: registered with ${want}, no longer found`);
      else if (actual !== want) drifted.push(`${route}: registered ${want}, now ${actual}`);
    }
    expect(
      drifted.sort(),
      'a registered team-scoped write changed or lost its role gate — if that is intended, say so ' +
        'here and in the team-roles taxonomy:',
    ).toEqual([]);
  });

  it('CRITICAL no team-scoped write is missing from the roster. A new route that reaches another account is registered here or it fails, which is the half that catches an addition rather than a deletion.', () => {
    const unregistered = writes()
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !(k in ROSTER))
      .sort();
    expect(
      unregistered,
      'these writes act on an effective account and are not registered above — add them with the ' +
        'gate they carry:',
    ).toEqual([]);
  });

  it('CRITICAL the recognised gates are exactly the ones V-837 knows. If a new gating helper is registered here and not there, a role check can hide where that guard cannot attribute it; registered there and not here, its routes read as ungated. Sharing one list is what keeps both true.', () => {
    const used = new Set(writes().flatMap((r) => r.gates));
    used.delete('inline role check');
    const unknown = [...used].filter((g) => !gatingHelpers().includes(g)).sort();
    expect(unknown, 'gate used by a route that V-837 does not list as a gating helper:').toEqual(
      [],
    );
  });
});
