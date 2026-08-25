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

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, '..', '..', 'src', 'routes');

/**
 * Every file that can mark a request control-key-authorized.
 *
 * V-1601 — this read `agent-sessions.ts` alone while claiming a property about a
 * control-key request. `agent-sessions-livekit-token.ts` and
 * `agent-sessions-transport-report.ts` carry their own copy of the auth shape and
 * set the same flag, so both were outside a check whose sentence covers them.
 * Their lookups do resolve to the path session — verified before widening, not
 * after — which is the usual answer and not a reason to leave the scan narrow.
 */
function controlKeyFiles(): string[] {
  const files = readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(ROUTES, f))
    .filter((f) => /req\.guiControlKeyAuthorized\s*=\s*true/.test(codeOf(readFileSync(f, 'utf8'))));
  expect(files.length, 'files that can set the control-key flag were found').toBeGreaterThanOrEqual(
    3,
  );
  return files;
}

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
    'the parameter of validateControlKey, called only as validateControlKey(req, sessionId) where sessionId is req.params.id; in the livekit-token and transport-report routes the same name is a local assigned directly from req.params.id',
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

/**
 * Session lookups across every control-key file.
 *
 * The receiver is matched as a FAMILY (`sessions`, `agentSessionsRepo`, …) rather
 * than by name. Naming them is what made the first version of this widening inert:
 * it matched `sessions.get` and a guessed `sessionRepo.get`, the siblings call
 * `agentSessionsRepo.get`, and both new files therefore contributed nothing while
 * the file reported itself widened.
 *
 * `await` is what separates a repository lookup from a Map read. Without it the
 * family pattern also caught `sessionUploadLifetimeBytes.get(rec.id)` — an
 * in-memory upload counter keyed by session id, which is not a session lookup at
 * all. Rostering those would have papered over a population that was simply
 * wrong; discriminating on the await keeps the set to the thing being asserted
 * about, and does it structurally rather than by another list of names.
 *
 * The per-file assertion below is the real defence — a file that yields no
 * lookups is a file this scan is not reading, whatever the regex says.
 */
function lookupArguments(): string[] {
  const out: string[] = [];
  for (const file of controlKeyFiles()) {
    const code = codeOf(readFileSync(file, 'utf8'));
    const hits = [...code.matchAll(/await\s+\w*[Ss]essions?\w*\.get\(\s*([^)]*?)\s*\)/g)];
    expect(
      hits.length,
      `${file.split('/').pop()} contributed no session lookups — the scan is not reading it`,
    ).toBeGreaterThan(0);
    for (const m of hits) out.push((m[1] ?? '').trim());
  }
  return out;
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
