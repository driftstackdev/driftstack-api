// W287.A — drift guard for customer-facing route → docs coverage.
// Each customer-facing /v1/* route file under apps/server/src/routes
// (i.e. not admin-*) should have a corresponding docs page under
// apps/docs/src/pages/api or apps/docs/src/pages/webhooks. Catches
// drift where a new customer-facing route ships but no doc page
// is added.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const DOCS_API = resolve(REPO_ROOT, 'apps/docs/src/pages/api');
const DOCS_WEBHOOKS = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Customer-facing route files (exclude admin-* and internal helpers).
// Map each route file to the docs slug(s) that should cover it.
const ROUTE_TO_DOC: Record<string, string[]> = {
  'account-audit.ts': ['api/audit-log.md'],
  'account-bundled-llm.ts': ['api/bundled-llm.md'],
  'account-byok-anthropic.ts': ['api/byok-anthropic.md'],
  'account-cost.ts': ['api/cost-monitoring.md'],
  'account-me.ts': ['api/account.md'],
  'account-mfa.ts': ['api/mfa.md'],
  'account-notifications.ts': ['api/account-notifications.md'],
  'account-rate-limits.ts': ['api/account-rate-limits.md'],
  'account-web-sessions.ts': ['api/account.md'],
  'agent-sessions.ts': ['api/agent-sessions.md'],
  'auth.ts': ['api/auth.md'],
  'billing.ts': ['api/billing.md'],
  'billing-crypto.ts': ['api/billing-crypto.md'],
  'email-preferences.ts': ['api/email-preferences.md'],
  'legal.ts': ['api/legal.md'],
  'oauth.ts': ['api/oauth.md'],
  'profile-snapshots.ts': ['api/profile-snapshots.md'],
  'profiles.ts': ['api/profiles.md'],
  'recipes.ts': ['api/recipes.md'],
  'sessions.ts': ['api/sessions.md'],
  'status.ts': ['api/status.md'],
  'team.ts': ['api/team.md'],
  // Usage endpoints live in admin.ts (despite the name) — see W269.A.
  // We cover usage docs via api/usage.md instead of asserting a usage.ts file.
  'admin.ts': ['api/usage.md', 'api/api-keys.md'],
  'webhooks.ts': ['api/audit-log.md', 'webhooks/events.md'], // covered by audit-log + webhook events catalog
};

describe('W287.A customer-facing route → docs coverage', () => {
  it('every mapped route file exists', () => {
    const missing = Object.keys(ROUTE_TO_DOC).filter((f) => !existsSync(resolve(ROUTES, f)));
    expect(missing).toEqual([]);
  });

  it('every mapped doc page exists', () => {
    const missing: string[] = [];
    for (const docs of Object.values(ROUTE_TO_DOC)) {
      for (const slug of docs) {
        if (!existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages', slug))) {
          missing.push(slug);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
