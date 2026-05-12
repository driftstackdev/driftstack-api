// W247.D — drift-guard for /docs (the hub). Pins the five subscribable
// webhook event types named in the hub's preview card to the live
// SubscribableWebhookEventTypeSchema. Also verifies every linked
// destination from the hub is a page that actually exists.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs.astro');
const DOCS_DIR = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs');
const PAGES_DIR = join(REPO, 'apps', 'marketing-site', 'src', 'pages');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W247.D /docs hub doc parity', () => {
  const doc = read();

  it('lists every SubscribableWebhookEventTypeSchema value', () => {
    const live = (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).slice();
    expect(live.length).toBeGreaterThanOrEqual(5);
    for (const evt of live) {
      expect(doc).toContain(evt);
    }
  });

  it('event-count phrasing matches the live enum size', () => {
    const live = (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).slice();
    if (live.length === 5) {
      expect(doc).toMatch(/All five event types/);
    } else {
      // If the enum grows, the doc must not silently keep "five".
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
