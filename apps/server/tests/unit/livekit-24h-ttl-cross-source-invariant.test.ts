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
});
