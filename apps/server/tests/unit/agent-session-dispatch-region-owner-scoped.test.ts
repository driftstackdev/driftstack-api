// V-736 — the fleet-dispatch region must be the OWNER's, never the caller's.
//
// On a team-admin launch (X-Driftstack-Account) the create handler owner-scopes
// everything else it threads into the dispatch: the session's accountId, the
// owner's profile DEK, their saved proxy, their BYOK key, the LiveKit identity
// `customer-<ownerAccountId>`, the audit row, the tier gate, the idempotency
// namespace. It passed `accountRegion: ctx.account.region` — the CALLER's.
//
// That value is the SOLE selection input to resolveLiveDispatchNode, and on a
// create there is no bound node_id yet, so it is the entire node selector rather
// than a rare fallback. A US-region admin launching for an EU-region owner
// therefore preferred a US box to decrypt the OWNER's profile store.
//
// The sibling route already made exactly this fix, with the reasoning written
// out at routes/agent-sessions-livekit-token.ts: "Use the caller's region ONLY
// when the caller IS the owner — a team admin's region is NOT the owner's".
// Passing null is region-BLIND rather than wrong-region: the repo query omits the
// region term entirely for null and degrades to pure LiveKit recency, so this is
// a narrowing.
//
// WHY THIS IS A SOURCE PIN AND NOT A BEHAVIOURAL TEST — stated plainly, because
// a pin is the weaker guard: proving node SELECTION end-to-end needs a fixture
// fleet with LiveKit-registered, control-WSS-connected boxes in two different
// regions, which buildTestApp does not provide. What this pins is that the route
// still makes the owner-scoped CHOICE. The existing
// agent-sessions-fleet-dispatch.test.ts covers the selection mechanics by calling
// dispatchSessionAssignOnCreate directly with an explicit accountRegion, which is
// precisely why it could never have caught this: it supplies the argument the
// route was getting wrong.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CREATE_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const TOKEN_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions-livekit-token.ts');

describe('V-736 agent-session dispatch region is owner-scoped', () => {
  it('both route files exist at their canonical paths', () => {
    expect(existsSync(CREATE_ROUTE)).toBe(true);
    expect(existsSync(TOKEN_ROUTE)).toBe(true);
  });

  it('the create route passes the caller region ONLY when the caller is the owner', () => {
    const body = readFileSync(CREATE_ROUTE, 'utf8');
    expect(body).toMatch(/const isOwnerCaller = ownerAccountId === ctx\.account\.id;/);
    expect(body).toMatch(/accountRegion: isOwnerCaller \? ctx\.account\.region : null,/);
    // The bare form must not come back. This is the whole defect in one line.
    expect(body).not.toMatch(/accountRegion: ctx\.account\.region,/);
  });

  it('the sibling token route still applies the same rule, so the two cannot diverge again', () => {
    // If this sibling is ever "simplified" back to the caller's region, the
    // reasoning that justifies the create-route fix disappears with it.
    const body = readFileSync(TOKEN_ROUTE, 'utf8');
    expect(body).toMatch(
      /const region = isOwnerCaller \? \(ctx\?\.account\.region \?\? null\) : null;/,
    );
    expect(body).toMatch(/a\s*\n?\s*\/\/ team admin's region is NOT the owner's/);
  });
});
