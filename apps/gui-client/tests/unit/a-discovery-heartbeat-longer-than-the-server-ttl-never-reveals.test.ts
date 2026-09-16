// CROSS-BOUNDARY PIN — the desktop window's Network-section reveal depends on an
// inequality between two constants in two processes, and until this file nothing
// named it and nothing measured it.
//
// THE COUPLING. The simulator drawer withholds its Network section until the
// session has actually reported a request, and a discovery poll is what looks for
// that first report: an opening burst, then one look every
// NETWORK_DISCOVERY_HEARTBEAT_MS for as long as the session is live
// (apps/gui-client/src/views/SimulatorWindow.tsx). The thing it looks AT is a
// per-session ring the server keeps in memory only, dropped once the session's last
// append is older than NETWORK_LOG_SESSION_TTL_MS
// (apps/server/src/services/session-network-log-store.ts).
//
// ⛔ THE FAILURE IF IT INVERTS, and why it is worth a file. A customer browses
// quietly, loads exactly one page, and goes back to reading. That single reported
// request sits in the ring. If the heartbeat is longer than the TTL, the sweep wins
// the race every time: the ring is gone before the next look lands, the look sees an
// empty page, and the Network section is never offered for the rest of a live
// session — the exact defect the heartbeat was introduced to fix, reintroduced from
// the other side of the boundary. There is no error on either side. The client's
// look is a healthy 200 with an empty list, which is indistinguishable from a
// session that never reported anything; the server's sweep is memory hygiene doing
// its job. Nothing logs, nothing reds, and the pane is simply never there.
//
// Today 900 s against 1800 s clears it by 2x. This file asserts the 2x, not merely
// "<": a heartbeat that only just fits leaves no room for the look that lands late
// (a backed-off retry, a slow request, a re-run that resumes a partly-elapsed gap),
// and the margin is the point of the pin.
//
// ⚠️ READ BY TEXT, NOT BY IMPORT, on purpose. This file is a `.test.ts`, so it runs
// in the node project (the gui-jsdom project's include is `.test.tsx` only) — where
// importing SimulatorWindow.tsx would mean React, jsdom and the window's whole mock
// surface for two integers. The regexes carry the house `\s*` slack at every join so
// the pre-commit re-wrap cannot red them at the push gate, and every extraction is
// asserted to have MATCHED before its value is used: a parity guard whose regex
// silently missed reads exactly like a parity guard that passed.
//
// MUTATIONS — applied, RUN and RESTORED on 2026-09-16, and what is recorded is what
// the runner PRINTED. Both source files were compared byte-for-byte against their
// snapshots after each, and this file re-ran 3/3 green at the end.
//   1. THE INEQUALITY, CLIENT SIDE — `NETWORK_DISCOVERY_HEARTBEAT_MS = 900_000` →
//      `1_800_000` in SimulatorWindow.tsx (raised to exactly the TTL, the cheapest
//      way to break it). 2 RED: the margin arm, "expected 3600000 to be less than or
//      equal to 1800000", and the literals arm, "expected 1800000 to be 900000".
//   2. THE INEQUALITY, SERVER SIDE — `NETWORK_LOG_SESSION_TTL_MS = 30 * 60 * 1000` →
//      `10 * 60 * 1000` (the plausible tuning: an in-memory store gets leaned on).
//      2 RED, the same two arms: "expected 1800000 to be less than or equal to
//      600000" and "expected 600000 to be 1800000". BOTH DIRECTIONS ARE THE POINT —
//      the reason a cross-boundary pin exists is that either file can be edited
//      alone, by someone with no reason to open the other.
//   3. THE CROSS-REFERENCE — reword the heartbeat's doc comment to say "the server's
//      idle-session sweep" instead of naming NETWORK_LOG_SESSION_TTL_MS. 1 RED, the
//      naming arm, and the message quotes the doc comment itself rather than the
//      whole file: "expected '/**\n * The cadence discovery settles…' to contain
//      'NETWORK_LOG_SESSION_TTL_MS'". That is the scoping working — a name anywhere
//      in an 11k-line file is not in front of the person changing the number.
//   4. THE MARGIN ITSELF — `heartbeatMs * 2` → `heartbeatMs` in the first arm,
//      applied TOGETHER with mutation 1. The margin arm goes GREEN (900 s doubled to
//      1800 s is still "<=" 1800 s) and only the literals arm reds: "expected
//      1800000 to be 900000". Recorded because it says exactly what each arm is
//      worth — the `* 2` is load-bearing and is NOT covered by mutations 1-2 on their
//      own, and the literals arm is the one that catches a heartbeat grown to meet
//      the TTL exactly.
//
// ⛔ WHAT THE FIRST DRAFT GOT WRONG, kept because the shape recurs. It opened the
// margin arm with the two literals as a "vacuity control". Mutations 1 and 2 then
// red on the LITERAL and returned before the inequality was ever evaluated — the
// guard the coupling actually needs was decorative, and a legitimate re-tune would
// have been "fixed" by editing the literal with nobody meeting the coupling. A
// control that runs BEFORE the claim can shield it; these are separate arms now.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT_PATH = join(__dirname, '..', '..', 'src', 'views', 'SimulatorWindow.tsx');
const SERVER_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'server',
  'src',
  'services',
  'session-network-log-store.ts',
);

/**
 * Read `export const <NAME> = <arithmetic>;` out of a source file and return its
 * value in ms.
 *
 * ⛔ FAILS LOUDLY AT EVERY STEP, because the silent version of this helper is worse
 * than no helper: a regex that stops matching (a rename, a re-wrap, a `satisfies`
 * clause) would otherwise hand back a default and the inequality would "pass" on a
 * number nobody wrote. The declaration must match, and its right-hand side must be
 * plain integer multiplication — anything else (a reference to another constant, a
 * computed expression) is a REAL change to how the bound is expressed and should
 * come here to be re-read, not be evaluated by guesswork.
 */
function msConstant(source: string, name: string, where: string): number {
  const decl = new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*([^;]+?)\\s*,?;`);
  const match = decl.exec(source);
  expect(match, `${name} is not declared as an exported const in ${where}`).not.toBeNull();
  const raw = (match as RegExpExecArray)[1].replace(/_/g, '').replace(/\s+/g, '');
  expect(raw, `${name} in ${where} is no longer plain integer arithmetic: ${raw}`).toMatch(
    /^\d+(?:\*\d+)*$/,
  );
  const value = raw.split('*').reduce((acc, part) => acc * Number(part), 1);
  // A parsed zero would satisfy every "<=" below while meaning the extraction broke.
  expect(value, `${name} in ${where} parsed to a non-positive value`).toBeGreaterThan(0);
  return value;
}

describe('the reveal heartbeat and the server ring TTL stay on the right sides of each other', () => {
  const client = readFileSync(CLIENT_PATH, 'utf8');
  const server = readFileSync(SERVER_PATH, 'utf8');

  /** Both files really were read, and they are the two DIFFERENT files this pin is
   *  about. Without this, one path resolving to the other — or to nothing — would
   *  still produce two numbers and an inequality that "held". */
  function assertSourcesAreTheRealOnes(): void {
    expect(client).toContain('export function visibleSimDrawerPanes');
    expect(server).toContain('export class SessionNetworkLogStore');
  }

  it('CRITICAL the discovery heartbeat clears the ring TTL with a 2x margin', () => {
    assertSourcesAreTheRealOnes();
    const heartbeatMs = msConstant(client, 'NETWORK_DISCOVERY_HEARTBEAT_MS', 'SimulatorWindow.tsx');
    const ttlMs = msConstant(server, 'NETWORK_LOG_SESSION_TTL_MS', 'session-network-log-store.ts');
    // THE PIN, and nothing before it that could fire first. ⛔ An earlier draft put
    // today's literals above this line as a vacuity control; both mutations then red
    // on the literal and this inequality was never evaluated — the guard the item
    // asked for would have been decorative, and a legitimate re-tune would have been
    // "fixed" by editing the literal without anyone meeting the coupling. The
    // literals now live in their own arm BELOW, where they are a tripwire rather
    // than a shield. A quiet session's single reported request must still be in the
    // ring when the next look lands, with room for a look that is late.
    expect(heartbeatMs * 2).toBeLessThanOrEqual(ttlMs);
  });

  it('CRITICAL the two numbers are the ones the comments quote', () => {
    // A SECOND, INDEPENDENT arm rather than a control on the first: the inequality
    // above holds for many pairs, and both doc comments state these particular
    // numbers in prose ("900 s against 1800 s", "4 requests per hour", "30 min").
    // Re-tuning either is legitimate; doing it without coming past the prose that
    // quotes it is not.
    assertSourcesAreTheRealOnes();
    expect(msConstant(client, 'NETWORK_DISCOVERY_HEARTBEAT_MS', 'SimulatorWindow.tsx')).toBe(
      900_000,
    );
    expect(msConstant(server, 'NETWORK_LOG_SESSION_TTL_MS', 'session-network-log-store.ts')).toBe(
      1_800_000,
    );
  });

  it('CRITICAL each constant names the other, so the coupling is visible where it is edited', () => {
    // A number that passes a suite nobody is running at the moment of the edit is not
    // a guard against the edit. Presence, not absence: these assert the
    // cross-reference IS written down, which is the direction a grep answers honestly.
    // And it must be written where the constant IS — a name that appears somewhere in
    // an 11k-line file is not in front of the person changing the number — so each
    // assertion is scoped to that constant's own doc comment, i.e. the block comment
    // immediately preceding its declaration.
    const heartbeatDoc =
      /\/\*\*(?:[^*]|\*(?!\/))*\*\/\s*export\s+const\s+NETWORK_DISCOVERY_HEARTBEAT_MS\s*=/.exec(
        client,
      );
    expect(heartbeatDoc, 'NETWORK_DISCOVERY_HEARTBEAT_MS has lost its doc comment').not.toBeNull();
    expect((heartbeatDoc as RegExpExecArray)[0]).toContain('NETWORK_LOG_SESSION_TTL_MS');
    const ttlDoc =
      /\/\*\*(?:[^*]|\*(?!\/))*\*\/\s*export\s+const\s+NETWORK_LOG_SESSION_TTL_MS\s*=/.exec(server);
    expect(ttlDoc, 'NETWORK_LOG_SESSION_TTL_MS has lost its doc comment').not.toBeNull();
    expect((ttlDoc as RegExpExecArray)[0]).toContain('NETWORK_DISCOVERY_HEARTBEAT_MS');
  });
});
