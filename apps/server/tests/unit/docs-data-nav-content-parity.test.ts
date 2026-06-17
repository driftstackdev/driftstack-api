// W463.A — drift guard for apps/docs/src/data/nav.ts.
// V-254 doc-site central navigation. Drift here either re-orders
// sections (Quickstart away from the top breaks the "new customer's
// first click" framing the section ordering pins) or drops entries
// from API reference / Webhooks sub-menus (broken sidebar for live
// docs traffic that landed before search-engines reindex).
//
//   • V-254 framing pinned + 'central doc-site navigation. Single
//     source of truth for the sidebar; pages reference this so
//     adding a topic = one edit here.'
//   • Categories-order intentional framing pinned + V-256 expansion
//     framing ('Quickstart section + per-topic Guides entries').
//   • DocNavItem 2-field (href + label) + DocNavSection 2-field
//     (label + items DocNavItem[]).
//   • DOC_NAV 6-section ordered list:
//     Overview → Get started → SDKs → Guides → API reference
//     → Webhooks.
//   • API reference 9 entries pinned including api-keys + team
//     + mfa + usage + audit-log + profiles + sessions.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/data/nav.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W463.A apps/docs/src/data/nav.ts content parity', () => {
  const body = read(LIB);

  it("V-254 framing pinned: 'V-254 — central doc-site navigation. Single source of truth for the sidebar; pages reference this so adding a topic = one edit here.'", () => {
    expect(body).toMatch(
      /\/\/ V-254 — central doc-site navigation\. Single source of truth for the\s*\n?\s*\/\/ sidebar; pages reference this so adding a topic = one edit here\./,
    );
  });

  it("Categories-order intentional framing pinned: 'Categories order intentional: Quickstart at the top so a new customer's first click lands on a \"I just got my key, what now\" page; Reference + Architecture at the bottom for spec-level depth.' + V-256 expansion framing 'V-256 expanded: Quickstart section + per-topic Guides entries.'", () => {
    expect(body).toMatch(
      /\/\/ Categories order intentional: Quickstart at the top so a new\s*\n?\s*\/\/ customer's first click lands on a "I just got my key, what now"\s*\n?\s*\/\/ page; Reference \+ Architecture at the bottom for spec-level depth\./,
    );
    expect(body).toMatch(/\/\/ V-256 expanded: Quickstart section \+ per-topic Guides entries\./);
  });

  it('DocNavItem 2-field interface (href + label both strings) + DocNavSection 2-field (label + items DocNavItem[])', () => {
    expect(body).toMatch(
      /export interface DocNavItem \{\s*\n?\s*href: string;\s*\n?\s*label: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface DocNavSection \{\s*\n?\s*label: string;\s*\n?\s*items: DocNavItem\[\];\s*\n?\s*\}/,
    );
  });

  it('DOC_NAV 6-section ordered list: Overview → Get started → SDKs → Guides → API reference → Webhooks (section labels pinned in this exact order)', () => {
    expect(body).toMatch(
      /export const DOC_NAV: DocNavSection\[\] = \[\s*\n?\s*\{\s*\n?\s*label: 'Overview',\s*\n?\s*items: \[\{ href: '\/', label: 'Introduction' \}\],\s*\n?\s*\},\s*\n?\s*\{\s*\n?\s*label: 'Get started',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/quickstart\/', label: 'Quickstart' \},\s*\n?\s*\{ href: '\/license-activation\/', label: 'License activation \(GUI client\)' \},\s*\n?\s*\],\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'SDKs',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/sdk\/', label: 'SDK overview' \},\s*\n?\s*\{ href: '\/sdk\/installation\/', label: 'Installation' \},\s*\n?\s*\{ href: '\/sdk\/versioning\/', label: 'Versioning policy' \},\s*\n?\s*\],\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'Guides',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/guides\/', label: 'Guides overview' \},\s*\n?\s*\{ href: '\/guides\/profile-management\/', label: 'Profile management' \},\s*\n?\s*\{ href: '\/guides\/session-lifecycle\/', label: 'Session lifecycle' \},/,
    );
    // Guides section extensions — pinned separately so the original
    // 3-entry block stays untouched. team-rbac was the late-2026-05
    // addition (W757 / W766); live-video shipped with the LK arc
    // (LK.6 + Arc 6 docs.live-video). Both must appear in the
    // sidebar for parity with /guides + /docs landing.
    expect(body).toMatch(/\{ href: '\/guides\/team-rbac\/', label: 'Team RBAC' \}/);
    expect(body).toMatch(/\{ href: '\/guides\/live-video\/', label: 'Live video' \}/);
  });

  it('API reference section: pinned entries (api-keys + team + mfa + usage + audit-log + profiles + proxies + sessions + 2 overview entries); ARC A added Account proxies between Profiles and Sessions', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'API reference',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/api\/', label: 'API overview' \},\s*\n?\s*\{ href: '\/api\/versioning\/', label: 'Versioning policy' \},\s*\n?\s*\{ href: '\/api\/api-keys\/', label: 'API keys' \},\s*\n?\s*\{ href: '\/api\/team\/', label: 'Team RBAC' \},\s*\n?\s*\{ href: '\/api\/mfa\/', label: 'Two-factor auth \(MFA\)' \},\s*\n?\s*\{ href: '\/api\/usage\/', label: 'Usage \+ quotas' \},\s*\n?\s*\{ href: '\/api\/audit-log\/', label: 'Audit log' \},\s*\n?\s*\{ href: '\/api\/profiles\/', label: 'Profiles' \},\s*\n?\s*\{ href: '\/api\/proxies\/', label: 'Account proxies' \},\s*\n?\s*\{ href: '\/api\/sessions\/', label: 'Sessions' \},/,
    );
  });

  // Arc 4 Wave 2.B sub-slice 8.20.n / AI-B4 — extension entries for
  // the v2-#8 agent-sessions surface + AI-B4 recipes surface. Pinned
  // separately from the original 9-entry block so the heritage test
  // stays untouched + the new entries get explicit drift coverage.
  it('API reference section additions: /api/agent-sessions/ + /api/recipes/ after Sessions', () => {
    expect(body).toMatch(/\{ href: '\/api\/agent-sessions\/', label: 'Agent sessions' \}/);
    expect(body).toMatch(/\{ href: '\/api\/recipes\/', label: 'Recipes' \}/);
  });

  it('Webhooks section: 3 entries (endpoints + events + replay) at section bottom', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'Webhooks',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/webhooks\/endpoints\/', label: 'Endpoints \(CRUD \+ rotate \+ test\)' \},\s*\n?\s*\{ href: '\/webhooks\/events\/', label: 'Event catalog' \},\s*\n?\s*\{ href: '\/webhooks\/replay\/', label: 'Replay deliveries' \},/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
