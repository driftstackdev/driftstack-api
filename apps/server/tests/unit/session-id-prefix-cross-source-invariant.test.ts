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
// (W363) the legacy sessions-livekit-token route was deleted (publisher over-grant).
const AGENT_LK = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions-livekit-token.ts');
const AGENT_REPO = resolve(REPO_ROOT, 'apps/server/src/db/agent-sessions-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('session id prefix (ses_ vs agt_) cross-source invariant', () => {
  const agentLk = read(AGENT_LK);
  const agentRepo = read(AGENT_REPO);

  it('routes/agent-sessions-livekit-token AGENT_SESSION_ID_RE pins the agt_ prefix with full UUID-with-dashes body', () => {
    expect(agentLk).toMatch(
      /const AGENT_SESSION_ID_RE = \/\^agt_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/;/,
    );
  });

  it('db/agent-sessions-repo create() mints id as agt_${randomUUID()} — pinned so the DB-side id minting matches the route-side AGENT_SESSION_ID_RE pattern (drift to a non-agt prefix would orphan freshly-minted rows from the validator)', () => {
    expect(agentRepo).toMatch(/const id = `agt_\$\{randomUUID\(\)\}`;/);
  });

  it('agent-sessions-livekit-token AGENT_SESSION_ID_RE matches the canonical UUID-with-dashes body shape (8-4-4-4-12 hex) after the agt_ prefix — pinned so the validator stays aligned with the public-id family', () => {
    const bodyShape =
      '\\[0-9a-f\\]\\{8\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{12\\}';
    expect(agentLk).toMatch(new RegExp(bodyShape));
  });
});
