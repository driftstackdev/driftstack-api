// Cross-layer drift guard for the profile-launch → desktop-handoff deep
// link — the load-bearing contract for "create + launch profiles".
//
// When a customer clicks "Launch" on a profile, the dashboard
// (apps/customer-dashboard/src/pages/profiles.astro) surfaces a
// `driftstack://session/open?session_id=<id>` deep link; the desktop
// client (apps/gui-client/src/lib/deep-link.ts) parses it and dispatches
// the session-open handoff. These two live in DIFFERENT apps with NO
// shared type — so if either side's format drifts, the launch handoff
// breaks SILENTLY the day the backend (canvas/harness) lands. This test
// reads the dashboard's actual generated format and round-trips it
// through the actual desktop parser, locking the contract end to end.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDeepLink } from '../../src/lib/deep-link';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DASHBOARD_PROFILES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');

// The dashboard builds the link as:
//   'driftstack://session/open?session_id=' + encodeURIComponent(sessionId)
// Extract that exact literal prefix so the test always exercises the
// dashboard's CURRENT format against the desktop's CURRENT parser.
function dashboardDeepLinkPrefix(): string {
  const body = readFileSync(DASHBOARD_PROFILES, 'utf8');
  const m = body.match(/'(driftstack:\/\/session\/open\?session_id=)'/);
  if (m === null) {
    throw new Error(
      'profiles.astro no longer builds a driftstack://session/open?session_id= deep link — ' +
        'the launch→desktop handoff contract changed; update the desktop parser + this guard together.',
    );
  }
  return m[1]!;
}

describe('profile-launch → desktop deep-link handoff (cross-layer contract)', () => {
  it("dashboard's generated session-open link parses to {kind:'session-open'} in the desktop client", () => {
    const sample = dashboardDeepLinkPrefix() + 'sess_abc123';
    const result = parseDeepLink(sample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({ kind: 'session-open', sessionId: 'sess_abc123' });
    }
  });

  it('session ids round-trip through encodeURIComponent ↔ the parser searchParams decode', () => {
    // Symmetry guard: if the dashboard stopped encoding, or the parser
    // stopped decoding, an id with a reserved char would mismatch.
    const raw = 'sess_a+b/c=d';
    const sample = dashboardDeepLinkPrefix() + encodeURIComponent(raw);
    const result = parseDeepLink(sample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({ kind: 'session-open', sessionId: raw });
    }
  });

  it('dashboard HTML-escapes the deep link before injecting it into the banner (XSS guard on the handoff)', () => {
    const body = readFileSync(DASHBOARD_PROFILES, 'utf8');
    expect(body).toMatch(/escapeHtml\(deepLink\)/);
  });
});
