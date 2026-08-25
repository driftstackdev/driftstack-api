// V-788 — what actually restricts the `gui_control` scope, derived rather than described.
//
// Three source files and a locked decision said customer keys "never carry" this scope and that
// "only enterprise self-hosted GUI keys" get it. Neither half held. `ELEVATED_SCOPES` in
// `services/api-keys.ts` withholds exactly two scopes — `admin` and `driftstack_internal_admin` —
// and that file's own comment lists `gui_control` among the customer-level scopes that "stay
// grantable under account_owner". Any `account_owner` on an apiAccess tier can mint a key carrying
// it. Issuing it only for the self-hosted GUI is convention.
//
// The sentence sat directly above the auth gate on the manual-control plane, which is the one place
// a reader is deciding how much a compromised customer key can reach. A comment that overstates a
// boundary there is worse than no comment.
//
// So this file asserts the REAL shape of the restriction from the code, and the parity pins over
// those comments now freeze a corrected sentence that this file keeps honest. If someone later
// decides the boundary should be real, these cases fail and say what to change.
//
// A note on the obvious fix, because it is wrong and the next person will reach for it:
// adding `gui_control` to `ELEVATED_SCOPES` would make it PERMANENTLY UNMINTABLE. That list means
// "the caller must already hold this exact scope", which bootstraps for `driftstack_internal_admin`
// from staff keys that hold it — but nothing anywhere holds `gui_control`, and no signup, OAuth
// grant or seed issues it. The list would deadlock the very workflow it is meant to protect. A tier
// gate is the shape that could work, and it would need to apply on the USE path too, not just at
// mint — a mint-only check lapses the moment an account downgrades, which is exactly the defect
// V-786 fixed for `vpnEgress`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** The scopes a caller must already hold in order to grant, read from the source. */
function elevatedScopes(): string[] {
  const src = read('apps/server/src/services/api-keys.ts');
  const m = /const ELEVATED_SCOPES: ApiKeyScope\[\] = \[([^\]]*)\]/.exec(src);
  expect(m, 'ELEVATED_SCOPES declaration found — did it get renamed?').not.toBeNull();
  return [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

describe('V-788 gui_control is restricted by scope, not by tier or deployment', () => {
  it('CRITICAL gui_control is NOT in ELEVATED_SCOPES, so an account_owner can grant it to itself. Three comments claimed the opposite, directly above the auth gate on the manual-control plane — the spot where a reader is working out how far a compromised customer key reaches. If this ever becomes false the claim becomes true and those comments should be restored, which is why the assertion is on the code rather than on the prose.', () => {
    const elevated = elevatedScopes();

    // Vacuity: an empty parse would make every membership check below pass.
    expect(elevated.length, 'scopes parsed out of the declaration').toBeGreaterThanOrEqual(2);
    expect(elevated, 'the two that ARE fenced').toEqual(
      expect.arrayContaining(['admin', 'driftstack_internal_admin']),
    );

    expect(
      elevated,
      'gui_control is not caller-fenced — if you are adding it here, read this file’s header first: it would be unmintable, because nothing holds it to grant it',
    ).not.toContain('gui_control');
  });

  it('CRITICAL the OAuth path IS the one place gui_control is fenced. This is the asymmetry the corrected comments now describe: a third-party OAuth client cannot obtain it, while the account owner can mint it directly. Losing this fence would make the scope reachable by any app the customer authorises.', () => {
    const oauth = read('apps/server/src/services/oauth.ts');
    const m = /OAUTH_ALLOWED_SCOPES[^=]*=\s*(?:new Set\()?\[([^\]]*)\]/.exec(oauth);
    expect(m, 'OAUTH_ALLOWED_SCOPES found').not.toBeNull();
    const allowed = [...(m?.[1] ?? '').matchAll(/'([a-z_:]+)'/g)].map((x) => x[1]!);

    expect(allowed.length, 'the allowlist parsed').toBeGreaterThan(1);
    expect(allowed, 'an OAuth client cannot ask for the manual-control plane').not.toContain(
      'gui_control',
    );
  });

  it('CRITICAL exactly one route enforces the scope, and it is the gui-input plane. The agent-session input-event route reaches the same mechanics through a different door and is gated on `write` plus a per-session control key — a reader who believes gui_control is THE manual-control boundary would miss it, which is half of why the old comment was misleading.', () => {
    const sessions = read('apps/server/src/routes/sessions.ts');
    expect(sessions).toMatch(/requireScope\('gui_control'\)/);

    const agentSessions = read('apps/server/src/routes/agent-sessions.ts');
    expect(
      /requireScope\('gui_control'\)/.test(agentSessions),
      'the second mechanics plane does NOT use this scope — that is the current design, pinned so a reader is not surprised by it',
    ).toBe(false);
  });

  it('CRITICAL no source or customer-facing doc claims the scope is limited to enterprise or self-hosted keys. That sentence was false in three files at once and one of them is the customer scope reference, so a customer sizing their own key blast radius was reading a boundary that did not exist.', () => {
    const surfaces = [
      'apps/server/src/routes/sessions.ts',
      'apps/server/src/schemas/gui-input.ts',
      'apps/docs/src/pages/reference/scopes.md',
    ];

    for (const rel of surfaces) {
      const body = read(rel);
      expect(body, `${rel} still claims customer keys cannot hold gui_control`).not.toMatch(
        /customer keys never carry this[;,]/i,
      );
      expect(body, `${rel} still claims the scope is enterprise-only`).not.toMatch(
        /only (?:keys minted for the self-hosted GUI workflow \(enterprise tier\)|enterprise self-hosted GUI\s*\/\/ keys do)/i,
      );
      expect(body, `${rel} still claims the workflow is the only holder`).not.toMatch(
        /Self-hosted GUI workflow only/i,
      );
    }
  });
});
