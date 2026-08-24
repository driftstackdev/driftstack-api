// Cross-source invariant: the 24-hour LiveKit token TTL + 24h
// gui_control_key TTL must all agree across the routes, services, and
// docs. Q2=C verdict locked 24h. Drift would either expire tokens
// before the customer's reasonable session, or hold them past intent.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LK_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions-livekit-token.ts');
const AGENT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const DOCS_LIVE_VIDEO = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/live-video.md');
const DOCS_AGENT_SESSIONS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('LiveKit 24h-TTL cross-source invariant', () => {
  const lkRouteSrc = read(LK_ROUTE);
  const agentRouteSrc = read(AGENT_ROUTE);
  const liveVideoDocs = read(DOCS_LIVE_VIDEO);
  const agentSessionsDocs = read(DOCS_AGENT_SESSIONS);

  it('routes/agent-sessions-livekit-token exports LIVEKIT_TOKEN_TTL_SECONDS = 24 * 60 * 60', () => {
    expect(lkRouteSrc).toMatch(/export const LIVEKIT_TOKEN_TTL_SECONDS = 24 \* 60 \* 60;/);
  });

  // V-1429 — a THIRD copy of the LiveKit TTL, which this file did not cover.
  //
  // `routes/agent-sessions.ts` mints a LiveKit token inline on the session
  // create/get responses (`maybeMintLivekit`) and writes its own
  // `const ttlSeconds = 24 * 60 * 60;` rather than reading the exported constant.
  // The arms above pin the constant in the lk-token route and the gui_control_key
  // TTL in this same file — but not this one, so the inline mint could drift to a
  // different lifetime while every existing arm stayed green and the docs kept
  // claiming 24 hours.
  //
  // Asserted as a COMPARISON between the two source expressions rather than as a
  // second literal: two pinned literals can both be updated to agree on a new wrong
  // value, while "these two expressions are the same text" cannot be satisfied by
  // changing only one. The inline site is disambiguated by its `ttlSeconds` name —
  // the other `24 * 60 * 60` in this file is `guiControlKeyTtlMs`, in milliseconds.
  //
  // It could instead be deduplicated in source, but not cheaply: the lk-token route
  // already imports from `agent-sessions.ts`, so importing the constant back would
  // be circular, and relocating it to `lib/livekit-token.ts` would break two
  // content-parity pins that hold it in its current file with its JSDoc. Guarding
  // the copy is the proportionate move; the dedup is recorded as an option.
  it('CRITICAL the inline LiveKit mint in routes/agent-sessions uses the SAME TTL expression as LIVEKIT_TOKEN_TTL_SECONDS. It is a third copy of a value the docs publish as 24 hours, and nothing else in this file reaches it.', () => {
    const exported = /export const LIVEKIT_TOKEN_TTL_SECONDS = ([^;]+);/.exec(lkRouteSrc);
    expect(exported?.[1], 'the exported TTL expression is no longer readable').toBeDefined();

    // Disambiguated by the identity the token is minted FOR. `agent-sessions.ts`
    // mints twice: the harness/publisher token (`harness-<mac>`, canPublish:true,
    // deliberately 6h) and the customer viewer token (`customer-<account>`,
    // canPublish:false, 24h). A bare `const ttlSeconds` regex matches the publisher
    // first and compares the wrong lifetime — which is exactly what the first draft
    // of this arm did, and it is how the second mint was found at all.
    const inline = /const ttlSeconds = ([^;]+);[\s\S]{0,400}?identity: `customer-/.exec(
      agentRouteSrc,
    );
    expect(
      inline?.[1],
      'the customer-identity LiveKit mint no longer declares `const ttlSeconds` — if it was renamed, re-point this arm rather than deleting it',
    ).toBeDefined();

    expect(
      inline?.[1]?.trim(),
      'the inline mint and the exported constant have drifted apart',
    ).toBe(exported?.[1]?.trim());
  });

  it('routes/agent-sessions defaults guiControlKeyTtlMs = 24 * 60 * 60 * 1000 (Q2=C 24h verdict)', () => {
    expect(agentRouteSrc).toMatch(/guiControlKeyTtlMs = 24 \* 60 \* 60 \* 1000,/);
    expect(agentRouteSrc).toMatch(/gui_control_key\. Q2=C verdict locked 24h/);
  });

  it("docs/guides/live-video.md references 24-hour TTL in both 'For pre-existing sessions, or to re-mint after the 24-hour token TTL expires' AND 'Tokens are 24-hour HS256 JWTs signed with a per-Mac secret.' — pinned so the customer-facing TTL claim stays in sync with the route constant", () => {
    expect(liveVideoDocs).toMatch(
      /For pre-existing sessions, or to re-mint after the 24-hour token\s*\n?\s*TTL expires:/,
    );
    expect(liveVideoDocs).toMatch(/Tokens are 24-hour HS256 JWTs signed with a per-Mac secret\./);
  });

  it("docs/api/agent-sessions.md pins 'Token TTL is 24 hours (matches the gui_control_key TTL).' — pinned so the customer-facing cross-reference between LiveKit token TTL + gui_control_key TTL stays in sync (drift on either side would orphan the docs claim)", () => {
    expect(agentSessionsDocs).toMatch(
      /Token TTL is \*\*24 hours\*\* \(matches the `gui_control_key` TTL\)\./,
    );
  });

  it("routes/agent-sessions-livekit-token JSDoc explicitly cross-references the gui_control_key TTL match: '24h matches gui_control_key + the agent-session lifecycle' + 'LiveKit's max is 6h, but the SFU re-checks at handshake only, so post-handshake long-lived connections survive the token expiry' — pinned so the gui_control_key-symmetry + LiveKit-6h-cap-only-at-handshake rationale all stay documented", () => {
    expect(lkRouteSrc).toMatch(
      /Token TTL — 24h matches gui_control_key \+ the agent-session\s*\n?\s*\*\s+lifecycle\. LiveKit's max is 6h, but the SFU re-checks at\s*\n?\s*\*\s+handshake only/,
    );
  });

  // V-1430 — the OTHER inline mint, and why the two must not be unified.
  //
  // `agent-sessions.ts` mints a second LiveKit token for the harness/publisher
  // (`identity: harness-<mac>`, `canPublish: true`) at 6h, against the customer
  // viewer's 24h. That looks like drift and is not. The exported constant's own
  // JSDoc states the rule: "LiveKit's max is 6h, but the SFU re-checks at handshake
  // only, so post-handshake long-lived connections survive the token expiry."
  //
  // So the customer token KNOWINGLY exceeds LiveKit's cap — a reconnect re-mints —
  // while the publisher, the Mac that establishes and holds the room, stays inside
  // it. Unifying them would push the publisher past the documented maximum.
  //
  // This arm exists because that unification is the obvious-looking cleanup. While
  // writing V-1429 I considered exactly it, before finding the second mint at all;
  // the value differs from the one I had grepped for, so an enumeration of
  // `24 * 60 * 60` could not see it. A guard that only pins the customer TTL would
  // have let the "tidy up the duplicate" change through.
  it("CRITICAL the harness/publisher token stays at 6h — LiveKit's documented maximum — and is NOT unified with the 24h customer TTL. The customer token deliberately exceeds the cap because the SFU re-checks at handshake only; the publisher holds the room and must not.", () => {
    const publisher = /const ttlSeconds = ([^;]+);[\s\S]{0,400}?identity: `harness-/.exec(
      agentRouteSrc,
    );
    expect(
      publisher?.[1],
      'the harness LiveKit mint no longer declares `const ttlSeconds` before a harness- identity',
    ).toBeDefined();
    expect(publisher?.[1]?.trim(), "the publisher token left LiveKit's 6h cap").toBe('6 * 60 * 60');

    const customer = /const ttlSeconds = ([^;]+);[\s\S]{0,400}?identity: `customer-/.exec(
      agentRouteSrc,
    );
    expect(
      publisher?.[1]?.trim(),
      'the two mints were unified — the publisher must stay within the 6h cap the constant JSDoc names, and the customer token is the one allowed to exceed it',
    ).not.toBe(customer?.[1]?.trim());
  });

  it("the rationale this file leans on is still written where it claims: the exported constant's JSDoc names LiveKit's 6h maximum and the handshake-only re-check. If that comment goes, the arm above is asserting a rule nobody records.", () => {
    expect(lkRouteSrc).toMatch(/LiveKit's max is 6h/);
    expect(lkRouteSrc).toMatch(/re-checks at\s*\n?\s*\*\s*handshake only/);
  });
});
