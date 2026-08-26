// A per-session control key authorises THIS session, and the gate must prove it from
// the route's own `:id`.
//
// `gui_control_key` is minted per agent session and, once valid, `return`s BEFORE
// `app.requireScope(...)` runs — V-1599 quotes that mechanism and derives what the key
// can REACH. This file covers the other axis of the same credential: not which routes
// it reaches, but whether reaching one proves anything about WHICH SESSION. A gate that
// validated the key without the route's id would let a key minted for session A drive
// session B — the same account boundary the ownership check enforces on the account
// path, bypassed on the control-key path, on routes that mutate a live browser.
//
// ⛔ Why a guard rather than a read: there are THREE independent implementations of
// `controlKeyOrAccountAuth` (agent-sessions.ts, agent-sessions-livekit-token.ts,
// agent-sessions-transport-report.ts). Audited 2026-08-26, all three bind identically.
// Nothing asserted it. Three copies of an auth gate is exactly the population where one
// gets edited and the others do not, and the divergence would be invisible: the odd one
// out still compiles, still authenticates, and only stops checking WHOSE session.
//
// DERIVED, not listed. The implementations are discovered by scanning `routes/` for the
// declaration, so a fourth copy is covered the day it is written — which is the case
// that matters, since the fourth is the one nobody remembers to add to a roster.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, '..', '..', 'src', 'routes');

/** Any spelling that validates a per-session control key. */
const VALIDATOR = /validate(Gui)?ControlKey\s*\(/;

interface Gate {
  file: string;
  body: string;
}

/**
 * Every `controlKeyOrAccountAuth` implementation, discovered rather than listed.
 *
 * The body runs from the declaration to the next top-level declaration, capped so a
 * trailing function cannot absorb the rest of the module — the same bound
 * `every-activation-gate-has-a-refusing-disabled-variant` uses, and for the same
 * reason: an over-wide body makes the assertion pass on a neighbour's code.
 */
function gates(): Gate[] {
  const out: Gate[] = [];
  for (const entry of readdirSync(ROUTES)) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(resolve(ROUTES, entry), 'utf8');
    for (const m of text.matchAll(/(?:const|function)\s+controlKeyOrAccountAuth\s*[=(]/g)) {
      const start = m.index ?? 0;
      const nextConst = text.indexOf('\n  const ', start + 1);
      const nextFn = text.indexOf('\n  function ', start + 1);
      const ends = [nextConst, nextFn].filter((x) => x > 0);
      const end =
        ends.length > 0 ? Math.min(...ends, start + 4000) : Math.min(start + 4000, text.length);
      out.push({ file: entry, body: text.slice(start, end) });
    }
  }
  return out;
}

describe('every control-key gate binds the route id', () => {
  it('CRITICAL the scan finds the real population — a census that finds nothing asserts nothing', () => {
    const found = gates();
    expect(
      found.map((g) => g.file).sort(),
      'fewer than the three known implementations — the declaration idiom changed and this file went blind',
    ).toEqual(
      [
        'agent-sessions-livekit-token.ts',
        'agent-sessions-transport-report.ts',
        'agent-sessions.ts',
      ].sort(),
    );
    // The bodies must be real bodies, not empty slices: an empty string would satisfy
    // no regex below and the arms would fail loudly, but a body that is merely TOO
    // SHORT to contain the gate would pass by accident if the assertions were negative.
    for (const g of found) {
      expect(g.body.length, `${g.file}: extracted body is implausibly short`).toBeGreaterThan(200);
    }
  });

  it('CRITICAL every implementation reads the session id from the ROUTE PARAMS and feeds it to the control-key validator', () => {
    const offenders = gates()
      .filter((g) => {
        // (a) the id is read FROM THE ROUTE PARAMS into a named variable
        const read =
          /(?:const|let)\s+(\w+)\s*=\s*\(req\.params as \{\s*id\?:\s*string\s*\}\)\.id/.exec(
            g.body,
          );
        if (read === null) return true;
        const idVar = read[1] ?? '';
        // (b) a control-key validator is invoked at all
        const validator = VALIDATOR.exec(g.body);
        if (validator === null) return true;
        // (c) that variable is USED between being read and the validation — either
        //     handed to the validator directly, or used to fetch the session row the
        //     validator is given. ⛔ Asserting one SPELLING here is what produced a
        //     two-file false-positive list on the first attempt: `agent-sessions.ts`
        //     passes `sessionId`, while the other two pass the `session` ROW fetched
        //     with it, which is a stronger binding expressed differently. Both must
        //     pass; what matters is that the route's own id reaches the decision.
        // ⚠️ The region must run from the read THROUGH the validator's arguments, not
        // up to its opening paren. Stopping at `validator.index` excluded
        // `validateControlKey(req, sessionId)` — the id is used INSIDE the call — and
        // flagged the one file that binds most directly. Second false positive this
        // detector produced; both were the boundary, not the code.
        const region = g.body.slice(read.index + read[0].length, validator.index + 400);
        return !new RegExp(`\\b${idVar}\\b`).test(region);
      })
      .map((g) => g.file);
    expect(
      offenders,
      'control-key gate(s) that do not prove the key belongs to THIS route id — a key minted for one ' +
        'session would authorise another',
    ).toEqual([]);
  });
});
