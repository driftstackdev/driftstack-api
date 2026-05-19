// Cross-source invariant: customer-facing session ids carry the `ses_`
// prefix (driftstack sessions) and agent sessions carry `agt_`. The
// prefixes must NEVER cross — drift would let a session-id slip into
// an agent-session-token-mint flow (or vice versa) and silently 404
// every legitimate request. Both regexes share the same UUID-with-
// dashes body shape.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SESSIONS_LK = resolve(REPO_ROOT, 'apps/server/src/routes/sessions-livekit-token.ts');
const AGENT_LK = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions-livekit-token.ts');
const AGENT_REPO = resolve(REPO_ROOT, 'apps/server/src/db/agent-sessions-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('session id prefix (ses_ vs agt_) cross-source invariant', () => {
  const sessionsLk = read(SESSIONS_LK);
  const agentLk = read(AGENT_LK);
  const agentRepo = read(AGENT_REPO);

  it('routes/sessions-livekit-token SESSION_ID_RE pins the ses_ prefix (NOT sess_) with full UUID-with-dashes body', () => {
    expect(sessionsLk).toMatch(
      /const SESSION_ID_RE = \/\^ses_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/;/,
    );
  });

  it('routes/agent-sessions-livekit-token AGENT_SESSION_ID_RE pins the agt_ prefix with full UUID-with-dashes body', () => {
    expect(agentLk).toMatch(
      /const AGENT_SESSION_ID_RE = \/\^agt_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/;/,
    );
  });

  it('db/agent-sessions-repo create() mints id as agt_${randomUUID()} — pinned so the DB-side id minting matches the route-side AGENT_SESSION_ID_RE pattern (drift to a non-agt prefix would orphan freshly-minted rows from the validator)', () => {
    expect(agentRepo).toMatch(/const id = `agt_\$\{randomUUID\(\)\}`;/);
  });

  it("routes/sessions-livekit-token comment explicitly differentiates ses_ vs sess_: 'Customer-facing session ids carry the `ses_` prefix (NOT `sess_`) followed by a UUID-with-dashes.' — pinned so the not-sess_ guidance stays documented (drift to sess_ would mismatch the rest of the public-id family)", () => {
    expect(sessionsLk).toMatch(
      /Customer-facing session ids carry the `ses_` prefix \(NOT `sess_`\)\s*\n?\s*\/\/ followed by a UUID-with-dashes\./,
    );
  });

  it('Both prefix-regexes match the same UUID-with-dashes body shape (8-4-4-4-12 hex pattern). The only differentiator is the prefix — pinned so cross-token-type confusion stays impossible at the validator boundary', () => {
    const bodyShape =
      '\\[0-9a-f\\]\\{8\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{12\\}';
    expect(sessionsLk).toMatch(new RegExp(bodyShape));
    expect(agentLk).toMatch(new RegExp(bodyShape));
  });
});
