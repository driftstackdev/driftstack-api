// W487.B — server-side ownership guard for the static admin
// status-subscribers page. Pins safe offset paging, generation-owned
// reads, mutation reconciliation, auth, deadline, and tombstone behavior.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W487.B apps/admin-panel/src/pages/status-subscribers.astro content parity', () => {
  const body = read(LIB);

  it('exists at the canonical path with V-312/V-295c3/V-281 framing', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ V-312 — admin view of status-page email subscribers \(V-295c3 \+\s*\/\/ V-295c3-tombstone\)\. Read \/v1\/admin\/status-subscribers; expose a\s*\/\/ force-unsubscribe button per row\. Audit log dual-write happens\s*\/\/ server-side \(V-281 pattern\)\./,
    );
    expect(body).toMatch(
      /Email addresses subscribed to status\.driftstack\.dev incident notifications\. Confirmed\s*subscribers receive emails when public incidents are posted or resolved\. A forced\s*unsubscribe is also written to the admin audit log\./,
    );
  });

  it('starts paging controls inert and exposes explicit Previous/Next controls', () => {
    expect(body).toMatch(/data-page-previous\s*disabled\s*aria-disabled="true"/);
    expect(body).toMatch(/data-page-next\s*disabled\s*aria-disabled="true"/);
    expect(body).toContain('aria-label="Subscriber pages"');
    expect(body).toContain('Page unavailable');
  });

  it('requests limit=51 with the synchronous requested offset and renders only 50', () => {
    expect(body).toContain('const PAGE_SIZE = 50;');
    expect(body).toContain('const PAGE_FETCH_LIMIT = PAGE_SIZE + 1;');
    expect(body).toContain('let requestedOffset = 0;');
    expect(body).toContain('let renderedOffset = 0;');
    expect(body).toMatch(
      /apiBaseUrl \+\s*'\/v1\/admin\/status-subscribers\?limit=' \+\s*PAGE_FETCH_LIMIT \+\s*'&offset=' \+\s*targetOffset/,
    );
    expect(body).toContain('const nextSubscribers = fetchedRows.slice(0, PAGE_SIZE);');
    expect(body).toContain('const nextHasNext = fetchedRows.length > PAGE_SIZE;');
    expect(body).toContain('renderedHasNext = nextHasNext;');
  });

  it('allows Previous only above offset zero and Next only when the sentinel exists', () => {
    expect(body).toContain(
      'const canPrevious = subscriberDataAvailable && renderedOffset > 0 && !controlsBusy;',
    );
    expect(body).toContain(
      'const canNext = subscriberDataAvailable && renderedHasNext && !controlsBusy;',
    );
    expect(body).toContain('requestPage(renderedOffset - PAGE_SIZE);');
    expect(body).toContain('requestPage(renderedOffset + PAGE_SIZE);');
  });

  it('fences page commits and finalizers with the exact refresh-generation owner', () => {
    expect(body).toContain('let refreshGeneration = 0;');
    expect(body).toContain('let refreshOwner = null;');
    expect(body).toContain(
      'const owner = { generation: generation, controller: controller, offset: targetOffset };',
    );
    expect(body).toContain(
      'if (refreshOwner !== owner || generation !== refreshGeneration) return null;',
    );
    expect(body).toContain('if (refreshOwner === owner && generation === refreshGeneration) {');
    expect(body).toContain('const targetOffset = requestedOffset;');
  });

  it('rejects malformed full rows and the sentinel before publishing rows or mutation authority', () => {
    expect(body).toContain('function isSubscriber(value)');
    expect(body).toContain('SUBSCRIBER_FIELDS.every((field) => hasOwn(value, field))');
    expect(body).toContain("value.id.startsWith('sub_')");
    expect(body).toContain('EMAIL_RE.test(value.email)');
    expect(body).toContain('isIsoUtc(value.created_at)');
    expect(body).toContain('function parseSubscriberPage(body)');
    expect(body).toContain("!hasOwn(body, 'data')");
    expect(body).toContain('body.data.length > PAGE_FETCH_LIMIT');
    expect(body).toContain('!body.data.every(isSubscriber)');
    expect(body).toContain("throw responseContractError('Invalid subscriber list response')");
    expect(body).toMatch(
      /function responseContractError\(message\) \{\s*const error = new Error\(message\);\s*error\.staffSafe = true;/,
    );

    const parse = body.indexOf('const fetchedRows = parseSubscriberPage(body);');
    expect(parse).toBeGreaterThan(-1);
    expect(body.indexOf('renderedSubscribers = nextSubscribers;', parse)).toBeGreaterThan(parse);
    expect(body.indexOf('renderedOffset = targetOffset;', parse)).toBeGreaterThan(parse);
  });

  it('keeps the last authoritative page and row action evidence after a malformed refresh', () => {
    expect(body).toContain('let renderedSubscribers = [];');
    expect(body).toMatch(
      /if \(subscriberDataAvailable\) \{\s*requestedOffset = renderedOffset;\s*preserveRenderedPage = true;/,
    );
    expect(body).toContain('The previous page and action status are unchanged; retry when ready.');
    expect(body).toMatch(
      /if \(preserveRenderedPage\) \{\s*renderPage\(renderedSubscribers, renderedOffset\);/,
    );
    expect(body).toContain('committedForceUnsubs.has(id)');
    expect(body).toContain('uncertainForceUnsubs.has(id)');
  });

  it('keeps paging disabled from mutation acquisition through reconciliation', () => {
    expect(body).toContain(
      'const mutationReconciling = forceUnsubsInFlight.size > 0 || addInFlight;',
    );
    expect(body).toContain('const controlsBusy = readBusy || mutationReconciling;');
    expect(body).toContain('forceUnsubsInFlight.add(id);');
    expect(body).toContain('forceUnsubsInFlight.delete(id);');
    expect(body).toContain('addInFlight = true;');
    expect(body).toContain('addInFlight = false;');
  });

  it('reconciles ambiguous force-unsubscribe outcomes by origin, exact id, and unsubscribed_at without absence inference', () => {
    expect(body).toContain('function mutationOutcomeIsUnknown(err)');
    expect(body).toContain('return explicitStatus >= 500;');
    expect(body).toContain('const originOffset = renderedOffset;');
    expect(body).toContain('requestedOffset = originOffset;');
    expect(body).toContain(
      'reconciliation.fetchedRows.find((subscriber) => String(subscriber.id) === id)',
    );
    expect(body).toContain('exactRow && exactRow.unsubscribed_at');
    expect(body).toContain(
      'Absence from this slice is not evidence that the unsubscribe completed.',
    );
    expect(body).not.toContain('active, so it likely completed');
  });

  it('keeps accepted force-unsubscribe body-independent and latched against replay', () => {
    expect(body).toContain('The response body is unused. Trust the accepted status');
    expect(body).toContain('const committedForceUnsubs = new Set();');
    expect(body).toContain('committedForceUnsubs.add(id);');
    expect(body).toContain("'The force-unsubscribe was accepted; reload later to verify the row.'");
  });

  it('latches accepted force-subscribe before decoding and blocks malformed/invalid 201 replay', () => {
    expect(body).toMatch(
      /acceptedStatusCommitted = true;\s*const body = await response\.json\(\)\.catch\(\(\) => null\)/,
    );
    expect(body).toContain('function validForceSubscribeResult(body)');
    expect(body).toContain('addCommitDetailsUnavailable = true;');
    expect(body).toContain('Add subscriber committed, but result details are unavailable.');
    expect(body).toContain("? 'Added — verify'");
  });

  it('reconciles ambiguous add outcomes on offset zero and treats only active email presence as positive', () => {
    expect(body).toContain('responseError.httpStatus = response.status;');
    expect(body).toMatch(/addOutcomeUnknown = true;\s*requestedOffset = 0;/);
    expect(body).toContain('reconciliation.offset === 0');
    expect(body).toMatch(/typeof subscriber\.email === 'string' &&\s*!subscriber\.unsubscribed_at/);
    expect(body).toContain('absence from that page is not evidence that the add failed');
  });

  it('keeps recurring and manual refreshes behind the active mutation reconciliation owner', () => {
    expect(body).toContain(
      "refreshBtn.title = 'Wait for the current subscriber change to finish.';",
    );
    expect(body).toMatch(
      /refreshBtn\.addEventListener\('click',[\s\S]*?forceUnsubsInFlight\.size > 0 \|\| addInFlight/,
    );
    expect(body).toMatch(
      /setInterval\(function \(\) \{\s*if \(forceUnsubsInFlight\.size > 0 \|\| addInFlight\) return;/,
    );
  });

  it('renders nullable-email tombstones with no action and never filters rows by email', () => {
    expect(body).toContain('const canForceUnsub = !sub.unsubscribed_at && sub.email;');
    expect(body).toContain('(purged after retention period)');
    expect(body).toContain('<span class="text-xs text-tk-ink-3">no action</span>');
    expect(body).toContain("list.innerHTML = subs.map(row).join('');");
    expect(body).not.toMatch(/subs\.filter\(/);
  });

  it('preserves lifecycle badges and the five-character HTML escape map', () => {
    expect(body).toMatch(/if \(sub\.unsubscribed_at\)/);
    expect(body).toMatch(/if \(sub\.confirmed_at\)/);
    expect(body).toContain('>pending</span>');
    expect(body).toMatch(
      /\.replace\(\/\[&<>"'\]\/g, function \(c\) \{\s*if \(c === '&'\) return '&amp;';\s*if \(c === '<'\) return '&lt;';\s*if \(c === '>'\) return '&gt;';\s*if \(c === '"'\) return '&quot;';\s*return '&#39;'/,
    );
  });

  it('preserves canonical auth and the shared 15-second bounded transport', () => {
    expect(body).toMatch(/localStorage\.getItem\('ds_web_session_token'\) \|\| ''/);
    expect(body).toContain('const SUBSCRIBER_TIMEOUT_MS = 15_000;');
    expect(body).toContain(
      'window.driftstackFetchWithDeadline(url, init, SUBSCRIBER_TIMEOUT_MS, controller)',
    );
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('defers the first read until the AdminLayout SSO bridge turn', () => {
    expect(body).toMatch(
      /if \(document\.readyState === 'loading'\) \{\s*document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\);\s*\} else \{\s*start\(\)/,
    );
  });
});
