// Python SDK top-level __init__.py public-export parity.
//
// Mirrors the slice 112 TS SDK fix (re-exported customer-facing
// types from packages/sdk-typescript/src/index.ts that were
// previously deep-import-only). The Python SDK had the same gap:
// customer-facing pydantic models defined in
// packages/sdk-python/src/driftstack/resources/*.py but NOT
// re-exported from the top-level __init__.py — Python customers
// had to deep-import via
// `from driftstack.resources.team import TeamMember` etc.
//
// This drift-guard pins:
//   - the import lines for each resource module at the top of
//     __init__.py
//   - the __all__ entry for each type so `from driftstack import X`
//     stays in the public surface

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INIT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py');

const RE_EXPORTED_TYPES = [
  // From driftstack.resources.api_keys
  'ApiKeyList',
  // From driftstack.resources.sessions
  'SessionsListPage',
  // From driftstack.resources.team (5 types)
  'AcceptInviteResponse',
  'TeamInvite',
  'TeamInvitesList',
  'TeamMember',
  'TeamMembersList',
  'TeamOwner',
  'TeamOwnersList',
  // From driftstack.resources.webhooks (2 types)
  'WebhookDeliveryListPage',
  'WebhookEndpointList',
] as const;

describe('Python SDK __init__.py public-export parity', () => {
  const body = readFileSync(INIT, 'utf8');

  it('imports api_keys.ApiKeyList from driftstack.resources.api_keys', () => {
    expect(body).toMatch(/from driftstack\.resources\.api_keys import ApiKeyList/);
  });

  it('imports sessions.SessionsListPage from driftstack.resources.sessions', () => {
    expect(body).toMatch(/from driftstack\.resources\.sessions import SessionsListPage/);
  });

  it('imports the 7 team types from driftstack.resources.team in a single grouped statement', () => {
    // Grouped import keeps the public-surface footprint readable.
    expect(body).toMatch(
      /from driftstack\.resources\.team import \(\s*\n?\s*AcceptInviteResponse,\s*\n?\s*TeamInvite,\s*\n?\s*TeamInvitesList,\s*\n?\s*TeamMember,\s*\n?\s*TeamMembersList,\s*\n?\s*TeamOwner,\s*\n?\s*TeamOwnersList,\s*\n?\s*\)/,
    );
  });

  it('imports the 2 webhooks list-types from driftstack.resources.webhooks', () => {
    expect(body).toMatch(
      /from driftstack\.resources\.webhooks import WebhookDeliveryListPage, WebhookEndpointList/,
    );
  });

  it('all re-exported types appear in __all__ so `from driftstack import X` works', () => {
    // Pin every type by its quoted form inside the __all__ list.
    for (const t of RE_EXPORTED_TYPES) {
      expect(body, `__all__ missing "${t}"`).toMatch(new RegExp(`"${t}",`));
    }
  });

  it('LiveKitInfo (slice 61 + 63) still re-exported alongside the new 9 types — drift-guard against the new types accidentally displacing it', () => {
    expect(body).toMatch(/from driftstack\.resources\.agent_sessions import LiveKitInfo/);
    expect(body).toMatch(/"LiveKitInfo",/);
  });
});
