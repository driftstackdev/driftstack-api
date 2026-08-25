// W356.C — cross-source drift guard for the status-subscribers admin
// surface. It ties the page's offset/sentinel behavior and mutation
// endpoints to the live route and service contracts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W356.C /status-subscribers admin page parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const service = read(SERVICE);

  it('wires list, force-subscribe, and force-unsubscribe to registered server routes', () => {
    expect(route).toContain("'/v1/admin/status-subscribers'");
    expect(route).toContain("'/v1/admin/status-subscribers/force-subscribe'");
    expect(route).toContain("'/v1/admin/status-subscribers/:id/force-unsubscribe'");
    expect(body).toContain("'/v1/admin/status-subscribers?limit='");
    expect(body).toContain("'/v1/admin/status-subscribers/force-subscribe'");
    expect(body).toMatch(
      /\/v1\/admin\/status-subscribers\/'\s*\+\s*encodeURIComponent\(id\)\s*\+\s*'\/force-unsubscribe/,
    );
  });

  it('uses a 51-row lookahead inside the route max and passes a non-negative offset', () => {
    expect(body).toContain('const PAGE_SIZE = 50;');
    expect(body).toContain('const PAGE_FETCH_LIMIT = PAGE_SIZE + 1;');
    expect(body).toMatch(/'&offset='\s*\+\s*targetOffset/);
    expect(route).toMatch(/limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
    expect(route).toMatch(/offset:\s*z\.coerce\.number\(\)\.int\(\)\.min\(0\)/);
  });

  it('matches the route data-only envelope without inventing cursor or total metadata', () => {
    expect(route).toMatch(/return \{\s*data: rows\.map/);
    expect(body).toContain('const fetchedRows = parseSubscriberPage(body);');
    expect(body).toContain('const nextHasNext = fetchedRows.length > PAGE_SIZE;');
    expect(body).toContain('renderedHasNext = nextHasNext;');
    expect(body).not.toMatch(/body\.(?:has_more|next_cursor|total)/);
  });

  it('validates every route field, including the 51st sentinel, before committing page state', () => {
    for (const field of ['id', 'email', 'confirmed_at', 'unsubscribed_at', 'created_at']) {
      expect(route).toContain(`${field}:`);
      expect(body).toContain(`'${field}'`);
    }
    expect(body).toContain('function isSubscriber(value)');
    expect(body).toContain("value.id.startsWith('sub_')");
    expect(body).toContain('UUID_RE.test(value.id.slice(4))');
    expect(body).toContain('value.email.length <= 254');
    expect(body).toContain('(value.email !== null || value.unsubscribed_at !== null)');
    expect(body).toContain('function parseSubscriberPage(body)');
    expect(body).toContain('body.data.length > PAGE_FETCH_LIMIT');
    expect(body).toContain('!body.data.every(isSubscriber)');

    const parse = body.indexOf('const fetchedRows = parseSubscriberPage(body);');
    const slice = body.indexOf('const nextSubscribers = fetchedRows.slice(0, PAGE_SIZE);', parse);
    const offsetCommit = body.indexOf('renderedOffset = targetOffset;', parse);
    expect(parse).toBeGreaterThan(-1);
    expect(slice).toBeGreaterThan(parse);
    expect(offsetCommit).toBeGreaterThan(slice);
  });

  it('preserves the last trusted page and mutation latches on an invalid refresh', () => {
    expect(body).toContain('let renderedSubscribers = [];');
    expect(body).toContain('if (subscriberDataAvailable) {');
    expect(body).toContain('requestedOffset = renderedOffset;');
    expect(body).toContain('preserveRenderedPage = true;');
    expect(body).toContain('The previous page and action status are unchanged; retry when ready.');
    expect(body).toMatch(
      /if \(preserveRenderedPage\) \{\s*renderPage\(renderedSubscribers, renderedOffset\);/,
    );
  });

  it('force-unsubscribe retains the V-281 audit dual-write action and explicit confirmation', () => {
    expect(body).toMatch(/Audit log dual-write happens\s*\/\/ server-side \(V-281 pattern\)/);
    expect(route).toContain("'status_subscriber.force_unsubscribed'");
    expect(body).toMatch(/Force-unsubscribe '\s*\+\s*email/);
    expect(body).toContain(
      'Writes admin_audit_log. Customer can re-subscribe via the public form.',
    );
  });

  it('force-subscribe matches the canonical 201 response details and audit action', () => {
    expect(route).toContain("'status_subscriber.force_subscribed'");
    expect(route).toContain('return reply.code(201).send({');
    expect(route).toContain('unsubscribe_link: row.unsubscribeLink');
    expect(body).toContain("typeof body.id === 'string'");
    expect(body).toContain("typeof body.email === 'string'");
    expect(body).toContain("typeof body.unsubscribe_link === 'string'");
  });

  it('matches nullable email rows and displays a tombstone without an action', () => {
    expect(route).toContain('email: row.email');
    expect(body).toContain('const canForceUnsub = !sub.unsubscribed_at && sub.email;');
    expect(body).toContain('(purged after retention period)');
    expect(body).toContain('<span class="text-xs text-tk-ink-3">no action</span>');
  });

  it('keeps the 90-day retention statement aligned with the service default', () => {
    expect(body).toMatch(/scheduled 90-day post-unsubscribe purge/);
    expect(service).toMatch(
      /retentionMs:\s*number\s*=\s*90\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it('preserves incident fan-out and audit behavior in operator-facing copy', () => {
    expect(body).toMatch(
      /Confirmed\s+subscribers receive emails when public incidents are posted or resolved/,
    );
    expect(body).toMatch(
      /Confirmed-and-still-subscribed rows trigger fan-out emails on\s+public incident state changes/,
    );
    expect(body).toMatch(/A forced\s+unsubscribe is also written to the admin audit log/);
  });

  it('uses the canonical staff bearer key and all lifecycle badge states', () => {
    expect(body).toContain("localStorage.getItem('ds_web_session_token')");
    expect(body).toMatch(/>pending<\//);
    expect(body).toMatch(/>confirmed<\//);
    expect(body).toMatch(/unsubscribed '\s*\+/);
  });
});
