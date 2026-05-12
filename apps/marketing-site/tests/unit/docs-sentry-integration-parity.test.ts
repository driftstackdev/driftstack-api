// W352.A — drift guard for /docs/sentry-integration. The page was
// rewritten under W226.A specifically because the previous revision
// described a customer-configurable Sentry forwarder that did not
// exist in the codebase: no /v1/account/integrations/sentry endpoint,
// no DSN setting on the account row, no source_map_url field on
// CreateSessionRequest, no `script.error` webhook event type. This
// parity test pins the honesty posture so the fictional surface
// doesn't get re-introduced into the doc copy.
//
// Pinned:
//   • "no customer-configurable Sentry forwarder" disclaimer is
//     still on the page (not silently scrubbed)
//   • Server-side Sentry usage is real: apps/server/src/lib/sentry.ts
//     exists + ships the V-494 sensitive-key denylist
//   • NEGATIVE guards on the four fictional surfaces:
//       - no /v1/account/integrations/sentry route registered
//       - no sentry_dsn column on the account schema
//       - no source_map_url / release_tag field on
//         CreateSessionRequestSchema
//       - no `script.error` value in SubscribableWebhookEventTypeSchema
//   • Cross-links to /docs/webhooks + /docs/data-residency +
//     /docs/error-codes resolve
//   • integrations@driftstack.dev support contact pinned

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CreateSessionRequestSchema,
  SubscribableWebhookEventTypeSchema,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sentry-integration.astro');
const SENTRY_LIB = resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');
const DB_SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function readAllRoutes(): string {
  const out: string[] = [];
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (entry.endsWith('.ts')) out.push(readFileSync(join(ROUTES_DIR, entry), 'utf8'));
  }
  return out.join('\n');
}

describe('W352.A /docs/sentry-integration parity', () => {
  const body = read(PAGE);

  it('honesty disclaimer ("no customer-configurable Sentry forwarder today") still on the page', () => {
    expect(body).toMatch(/no customer-configurable\s*Sentry forwarder/);
    expect(body).toMatch(/<strong>Status:<\/strong>/);
  });

  it('server-side Sentry lib + V-494 scrub denylist exist (the page cites them)', () => {
    const sentry = read(SENTRY_LIB);
    expect(body).toContain('apps/server/src/lib/sentry.ts');
    expect(sentry).toMatch(/V-494[\s\S]{0,150}denylist/);
    // The page also claims the scrub strips raw API keys, session
    // secrets, customer URLs, webhook secrets. Pin the denylist
    // mentions on the lib side.
    expect(sentry).toMatch(/api[_-]?key|secret|token/i);
  });

  it('NEGATIVE: no /v1/account/integrations/sentry route registered server-side', () => {
    const allRoutes = readAllRoutes();
    expect(allRoutes).not.toContain('/v1/account/integrations/sentry');
    expect(allRoutes).not.toContain('integrations/sentry');
  });

  it('NEGATIVE: no sentry_dsn / sentryDsn column anywhere on the db schema', () => {
    const schema = read(DB_SCHEMA);
    expect(schema).not.toMatch(/sentry_dsn|sentryDsn/i);
  });

  it('NEGATIVE: CreateSessionRequestSchema has no source_map_url / release / sentryRelease field', () => {
    const fields = Object.keys(CreateSessionRequestSchema._def.shape() as Record<string, unknown>);
    for (const banned of ['source_map_url', 'sourceMapUrl', 'release', 'sentry_release']) {
      expect(fields).not.toContain(banned);
    }
  });

  it("NEGATIVE: 'script.error' is not in SubscribableWebhookEventTypeSchema", () => {
    const events = new Set<string>(
      (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
    );
    expect(events.has('script.error')).toBe(false);
  });

  it('page cites session.failed as the in-place mechanism for stack traces', () => {
    expect(body).toContain('session.failed');
    // session.failed IS subscribable — pin the bidirectional claim.
    const events = new Set<string>(
      (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
    );
    expect(events.has('session.failed')).toBe(true);
  });

  it('roadmap section cites the eventual /v1/account/integrations/sentry endpoint (not yet shipped)', () => {
    // The page documents what WILL exist. The negative guards above
    // confirm none of it exists today. When it ships, this test
    // should flip — and the negative guards above will start failing
    // first, surfacing the doc update need.
    expect(body).toMatch(/Roadmap:\s*control-plane forwarding/i);
    expect(body).toMatch(/<code>POST \/v1\/account\/integrations\/sentry<\/code>/);
    expect(body).toContain('integration.sentry.degraded');
  });

  it('Related cross-links to /docs/webhooks + /docs/data-residency + /docs/error-codes', () => {
    expect(body).toContain('/docs/webhooks');
    expect(body).toContain('/docs/data-residency');
    expect(body).toContain('/docs/error-codes');
  });

  it('contact for integration questions is integrations@driftstack.dev', () => {
    expect(body).toContain('integrations@driftstack.dev');
  });
});
