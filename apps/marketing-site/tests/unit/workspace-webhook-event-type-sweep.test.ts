// W277.A — workspace-wide sweep guard. Every `EVENT.subtype` looking
// string that documents a webhook event must be a member of
// WebhookEventTypeSchema. Catches drift where docs invent plausible
// event names like `session.started` or `webhook.delivered` that
// don't exist in the schema.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const liveEvents = new Set(WebhookEventTypeSchema.options);

// Cite-pattern: only inspect tokens that appear in webhook-payload
// JSON context, i.e. immediately after `"type":` or `'type':`. That
// rules out the noisy SDK-method / URL-path / audit-action collisions
// (e.g. `session.navigate`, `account.me`, `account.login`).
const eventLikeRe = /["']type["']\s*:\s*["']([a-z][a-z0-9_]+\.[a-z][a-z0-9_]+)["']/g;

describe('W277.A workspace-wide webhook event-type sweep', () => {
  it('every cited webhook event-like name is a real WebhookEventTypeSchema member', () => {
    const offenders: { file: string; event: string }[] = [];
    // Tokens that look like events but aren't documented webhook
    // events — known docs vocabulary we should ignore.
    const ignore = new Set([
      'account.id',
      'account.handle',
      'session.id',
      'session.status',
      'session.archetype',
      'session.created_at',
      'session.completed_at',
      'session.token',
      'session.minutes',
      'webhook.id',
      'webhook.secret',
      'webhook.url',
      'webhook.deliveries',
      'webhook.signature',
      'webhook.signing',
      'api_key.id',
      'api_key.scopes',
      'api_key.key',
      'api_key.last_used_at',
      'api_key.expires_at',
      'test.ts',
      'test.spec',
      'test.js',
      'test.py',
      'test.go',
      'test.runner',
      'test.event',
    ]);
    for (const f of allFiles) {
      // events.md is the catalog and intentionally lists [PLANNED]
      // event types that don't appear in the schema yet.
      if (f.endsWith('/webhooks/events.md')) continue;
      const body = read(f);
      const matches = [...body.matchAll(eventLikeRe)];
      for (const m of matches) {
        const token = m[1]!;
        if (ignore.has(token)) continue;
        if (!liveEvents.has(token as never)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), event: token });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
