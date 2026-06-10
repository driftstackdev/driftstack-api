// W247.D — drift-guard for /docs (the hub). Pins the LIVE subscribable
// webhook event types named in the hub's preview card to the live
// SubscribableWebhookEventTypeSchema. Also verifies every linked
// destination from the hub is a page that actually exists.
//
// Carve-out — DECLARED-but-not-LIVE values: the schema includes
// `session.egress_capability_changed` (Arc 5 EGRESS eg.7 declared
// 2026-05-16) but the marketing copy intentionally lags until the
// event has a concrete production emitter wired. The egress card
// contradiction pattern documented in
// project_egress_card_contradiction memory: schema + routes + UI
// ship as 503-stubs; disclaimers / marketing copy stay until
// concrete impl lands. This test honours that by excluding the
// DECLARED set from the strict-equality count + listing checks.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs.astro');
const DOCS_DIR = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs');
const PAGES_DIR = join(REPO, 'apps', 'marketing-site', 'src', 'pages');

/** Event types that are DECLARED in the schema but intentionally not
 *  marketed yet (no concrete emitter wired). When they graduate to
 *  LIVE, remove them from this set + update the hub copy. */
const DECLARED_NOT_LIVE = new Set<string>([
  'session.egress_capability_changed',
  // W393 — in the enum + subscribable, but the relay emitter wires in a
  // follow-up slice; not marketed as LIVE in the hub until then.
  'session.challenge_detected',
]);

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W247.D /docs hub doc parity', () => {
  const doc = read();

  it('lists every LIVE SubscribableWebhookEventTypeSchema value (DECLARED-not-LIVE values are excluded by design)', () => {
    const live = (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).filter(
      (v) => !DECLARED_NOT_LIVE.has(v),
    );
    expect(live.length).toBeGreaterThanOrEqual(5);
    for (const evt of live) {
      expect(doc).toContain(evt);
    }
  });

  it('event-count phrasing matches the LIVE enum size (DECLARED-not-LIVE values are excluded)', () => {
    const live = (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).filter(
      (v) => !DECLARED_NOT_LIVE.has(v),
    );
    if (live.length === 5) {
      expect(doc).toMatch(/All five event types/);
    } else {
      // If the LIVE set grows, the doc must not silently keep "five".
      expect(doc).not.toMatch(/All five event types/);
    }
  });

  it('every internal href the hub uses resolves to a real page', () => {
    const docFiles = new Set(readdirSync(DOCS_DIR));
    // Pull every href="/docs/foo" + href="/foo" out of the hub.
    const hrefs = Array.from(doc.matchAll(/href="(\/[a-z0-9-/]+)"/g)).map((m) => m[1]!);
    const missing: string[] = [];
    for (const href of hrefs) {
      if (href.startsWith('/docs/')) {
        const slug = href.slice('/docs/'.length).split('#')[0];
        if (!docFiles.has(`${slug}.astro`)) missing.push(href);
      } else {
        // top-level slug, e.g. /self-hosted, /api-reference.
        const slug = href.slice(1).split('#')[0];
        if (slug === '') continue;
        if (!existsSync(join(PAGES_DIR, `${slug}.astro`))) {
          missing.push(href);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
