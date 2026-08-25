// V-1600 — a gui_control_key authorizes ONE session. Every lookup in the file
// must resolve to that one.
//
// `validateGuiControlKey` decrypts the ciphertext stored on the session named in
// the PATH and `timingSafeEqual`s the presented header against it, so a key
// minted for session A cannot validate against session B. That binding is sound
// and is not what this file checks.
//
// What it checks is the step after. When the key validates, the request is marked
// `guiControlKeyAuthorized` and fourteen handlers then SKIP the account-ownership
// check — the comment on the factory says "for THAT session only". Nothing
// enforced the "that session" half: a handler that skipped ownership and then
// looked a session up by an id from anywhere else — a body field, a header, a
// query — would be reading or mutating a session the caller proved nothing about,
// and the scope invariant in `a-control-key-reaches-nothing-its-mint-does-not-require`
// would not see it, because the scope would be unchanged.
//
// Traced by hand once: all 21 `sessions.get` calls resolve to `req.params.id`.
// Seventeen say so literally; the other four go through helpers
// (`commitPairModeTransition`, `resolveAgentMessageAdmission`, the control-key
// validator itself) whose every call site passes `req.params.id`, plus one
// `created.id` on the create route, which is not control-key reachable — it takes
// `requireAuth` + `requireScope('write')`.
//
// That tracing is what this file preserves. The roster below is the four indirect
// arguments WITH the reason each is safe, so a new lookup from an unvetted source
// fails here and has to be argued for rather than merged.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_SESSIONS = resolve(HERE, '..', '..', 'src', 'routes', 'agent-sessions.ts');

/** The argument every control-key-reachable lookup should use. */
const PATH_SESSION = 'req.params.id';

/**
 * Indirect arguments, each with why it still resolves to the path session.
 *
 * A roster rather than a loosened pattern: `\w+` would accept a body-derived
 * local and this file would then assert nothing about the property it is named
 * for.
 */
const RESOLVES_TO_PATH_SESSION: Record<string, string> = {
  sessionId:
    'the parameter of validateControlKey, called only as validateControlKey(req, sessionId) where sessionId is req.params.id',
  'args.sessionId': 'commitPairModeTransition; all three call sites pass sessionId: req.params.id',
  agentSessionId:
    'resolveAgentMessageAdmission; both call sites pass req.params.id as the first argument',
  'created.id':
    'the freshly created session on POST /v1/agent-sessions, which is requireAuth + write and not control-key reachable',
};

/** Cut `//` to end of line, leaving string literals intact. */
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

function lookupArguments(): string[] {
  const code = codeOf(readFileSync(AGENT_SESSIONS, 'utf8'));
  return [...code.matchAll(/sessions\.get\(\s*([^)]*?)\s*\)/g)].map((m) => (m[1] ?? '').trim());
}

describe('a control-key request touches only its own session', () => {
  it('CRITICAL the scan found the lookups. Every assertion below is satisfied by an empty list, and a regex that stops matching would report perfect compliance — which is the shape this suite keeps finding in other guards.', () => {
    const args = lookupArguments();
    expect(args.length, 'session lookups found in agent-sessions.ts').toBeGreaterThanOrEqual(15);
    expect(
      args.filter((a) => a === PATH_SESSION).length,
      'most lookups still name the path session directly',
    ).toBeGreaterThanOrEqual(12);
  });

  it('CRITICAL every session lookup resolves to the session in the path. A control key proves possession for ONE session and then fourteen handlers skip the ownership check; a lookup keyed on anything else is that skip applied to a session the caller proved nothing about. The four indirect arguments are rostered with the reason each still resolves to the path session.', () => {
    const stray = lookupArguments()
      .filter((a) => a !== PATH_SESSION)
      .filter((a) => !(a in RESOLVES_TO_PATH_SESSION));
    expect(
      stray,
      'these look a session up by something other than the path id and are not rostered',
    ).toEqual([]);
  });

  it('CRITICAL a rostered argument that no longer appears is struck. An exemption outlives its reason silently, and a roster carrying entries for code that has gone is one nobody re-reads — the same failure the audit-row roster was corrected for.', () => {
    const args = new Set(lookupArguments());
    const gone = Object.keys(RESOLVES_TO_PATH_SESSION).filter((k) => !args.has(k));
    expect(gone, 'rostered here but no longer a session lookup — strike it').toEqual([]);
  });
});
