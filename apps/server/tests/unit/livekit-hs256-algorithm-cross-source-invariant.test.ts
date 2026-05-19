// Cross-source invariant: LiveKit token-minter uses HS256 (HMAC-
// SHA256) consistently across the lib + the route + the customer-
// facing docs. Drift on the JWT alg would either break LiveKit's
// signature verification (the SFU expects HS256) or weaken the
// security guarantee. The docs claim must match what the minter
// actually produces.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts');
const DOCS_AGENT = resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md');
const DOCS_LIVE_VIDEO = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/live-video.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('LiveKit HS256-algorithm cross-source invariant', () => {
  const lib = read(LIB);
  const route = read(ROUTE);
  const agentDocs = read(DOCS_AGENT);
  const liveVideoDocs = read(DOCS_LIVE_VIDEO);

  it("lib/livekit-token JWT header pins alg: 'HS256' + typ: 'JWT' — the actual cryptographic algorithm choice", () => {
    expect(lib).toMatch(/const header = \{ alg: 'HS256', typ: 'JWT' \};/);
  });

  it("lib/livekit-token header documents the LiveKit-handshake-HS256 requirement: 'LiveKit's WS handshake requires a short-lived HS256 JWT signed with' — pinned so the SFU-side-requirement context stays documented", () => {
    expect(lib).toMatch(/\/\/ LiveKit's WS handshake requires a short-lived HS256 JWT signed with/);
  });

  it("routes/sessions-livekit-token header documents 'short-lived HS256 JWT' delivery — pinned so the route's claim matches the lib's actual emit", () => {
    expect(route).toMatch(/The route hands a short-lived HS256 JWT \+ the WS URL back to the/);
  });

  it('docs/api/agent-sessions.md resource shape exposes "<HS256 JWT>" placeholder twice (once in the agent session resource + once in the explicit /livekit-token response) — pinned so the customer-facing documentation matches the actual JWT alg', () => {
    expect(agentDocs).toMatch(/"token": "<HS256 JWT>",/);
    // Count occurrences — should appear at least twice
    const count = (agentDocs.match(/<HS256 JWT>/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("docs/guides/live-video.md customer-facing claim: 'Tokens are 24-hour HS256 JWTs signed with a per-Mac secret.' — pinned so the customer-facing JWT alg claim matches the lib emission (drift would have customers misconfigure their LiveKit SDK to verify against the wrong alg)", () => {
    expect(liveVideoDocs).toMatch(/Tokens are 24-hour HS256 JWTs signed with a per-Mac secret\./);
  });
});
