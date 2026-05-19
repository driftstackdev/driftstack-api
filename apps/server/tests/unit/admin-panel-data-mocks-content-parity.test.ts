// Drift guard for apps/admin-panel/src/data/mocks.ts. Pins the 4
// mock-data exports (MOCK_ACCOUNTS / MOCK_AUDIT_LOG / MOCK_LEADS /
// MOCK_INCIDENTS) + their TypeScript interfaces. These are the
// SSG-fallback fixtures the admin panel renders before the live
// /v1/admin/* fetches replace them.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/data/mocks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel data/mocks content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("File-header framing pinned: 'Mock data for admin-panel scaffolding. Real reads against /v1/admin/* land when the panel moves past scaffolding.' Drift to dropping the SSG-fallback framing would let future-readers think these are production fixtures", () => {
    expect(body).toMatch(
      /\/\/ Mock data for admin-panel scaffolding\. Real reads against\s*\n?\s*\/\/ \/v1\/admin\/\* land when the panel moves past scaffolding\./,
    );
  });

  it('AccountTier import from @driftstack/api-types pinned: drift to a local-only enum would break the cross-package single-source-of-truth for the tier vocabulary', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
  });

  it('MockAdminAccount interface pinned: id + email + name (nullable) + tier + status (3-state enum) + createdAt + lastSeenAt (nullable). Drift to a different shape would break every admin-panel accounts-rendering surface that consumes MOCK_ACCOUNTS', () => {
    expect(body).toMatch(/export interface MockAdminAccount \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/email: string;/);
    expect(body).toMatch(/name: string \| null;/);
    expect(body).toMatch(/tier: AccountTier;/);
    expect(body).toMatch(/status: 'active' \| 'suspended' \| 'deleted';/);
    expect(body).toMatch(/createdAt: string;/);
    expect(body).toMatch(/lastSeenAt: string \| null;/);
  });

  it('MOCK_ACCOUNTS 3-fixture export pinned: 1 active + 1 active (agency_manual) + 1 suspended. Drift to dropping the suspended variant would orphan the admin status-badge UX from the suspended-state visual exercise', () => {
    expect(body).toMatch(/export const MOCK_ACCOUNTS: MockAdminAccount\[\] = \[/);
    expect(body).toMatch(/status: 'suspended',/);
    expect(body).toMatch(/tier: 'agency_manual',/);
    expect(body).toMatch(/tier: 'api_builder',/);
  });

  it('MockLead source 4-enum pinned: docs_signup | pricing_cta | email_inbound | other. Drift to dropping a source would break the leads-page filter-pill UI rendering', () => {
    expect(body).toMatch(/source: 'docs_signup' \| 'pricing_cta' \| 'email_inbound' \| 'other';/);
  });

  it('MockIncidentSeverity + MockIncidentStatus enums pinned (matches the slice-189 incidents/[id] page badges): drift would break the dynamic-route incident rendering', () => {
    expect(body).toMatch(/export type MockIncidentSeverity = 'minor' \| 'major' \| 'outage';/);
    expect(body).toMatch(
      /export type MockIncidentStatus = 'investigating' \| 'identified' \| 'monitoring' \| 'resolved';/,
    );
  });

  it('MOCK_INCIDENTS first-fixture timeline 3-update pattern pinned (investigating → identified → monitoring): drift to dropping a stage would weaken the demo + visually-degrade the timeline rendering in the SSG fallback', () => {
    expect(body).toMatch(/status: 'investigating',\s*\n?\s*postedAt:/);
    expect(body).toMatch(/status: 'identified',\s*\n?\s*postedAt:/);
    expect(body).toMatch(/status: 'monitoring',\s*\n?\s*postedAt:/);
  });
});
