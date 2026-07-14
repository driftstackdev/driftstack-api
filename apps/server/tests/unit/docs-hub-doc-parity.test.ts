// W247.D — drift-guard for /docs (the hub). Pins the LIVE subscribable
// webhook event types named in the hub's preview card to the
// SubscribableWebhookEventTypeSchema. Also verifies every linked
// destination from the hub is a page that actually exists.

import { readFileSync, existsSync } from 'node:fs';
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

function sourcePageForInternalHref(href: string): string | null {
  const pathname = href.split('#')[0]!.replace(/\/+$/, '');
  if (pathname === '') return null;
  if (pathname.startsWith('/docs/')) {
    return join(DOCS_DIR, `${pathname.slice('/docs/'.length)}.astro`);
  }
  return join(PAGES_DIR, `${pathname.slice(1)}.astro`);
}

describe('W247.D /docs hub doc parity', () => {
  const doc = read();

  it('lists every SubscribableWebhookEventTypeSchema value', () => {
    const events = SubscribableWebhookEventTypeSchema._def.values as readonly string[];
    expect(events).toHaveLength(8);
    for (const evt of events) {
      expect(doc).toContain(evt);
    }
  });

  it('event-count phrasing matches the current eight-event schema', () => {
    expect(doc).toMatch(/All eight subscribable event types/);
    expect(doc).not.toMatch(/All five event types/);
  });

  it('every internal href the hub uses resolves to a real page', () => {
    // Pull every href="/docs/foo/" + href="/foo/" out of the hub.
    const hrefs = Array.from(doc.matchAll(/href="(\/[a-z0-9-/]+)"/g)).map((m) => m[1]!);
    const missing = hrefs.filter((href) => {
      const sourcePage = sourcePageForInternalHref(href);
      return sourcePage !== null && !existsSync(sourcePage);
    });
    expect(missing).toEqual([]);

    // Canonical directory URLs map to their Astro source file; a fabricated
    // destination remains missing so this guard cannot become a false-green.
    expect(sourcePageForInternalHref('/docs/sdk-typescript/')).toBe(
      join(DOCS_DIR, 'sdk-typescript.astro'),
    );
    expect(existsSync(sourcePageForInternalHref('/docs/definitely-not-a-page/')!)).toBe(false);
  });
});
