// W380.B — drift guard for the load-bearing admin /status-subscribers
// contracts: offset paging with a one-row sentinel, exact-row mutation
// reconciliation, accepted-status commit latches, tombstone rendering,
// staff auth, and the shared bounded transport.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W380.B admin-panel /status-subscribers.astro page content parity', () => {
  const body = read(PAGE);

  it('uses the canonical AdminLayout and V-312/V-295c3/V-281 framing', () => {
    expect(existsSync(PAGE)).toBe(true);
    expect(body).toContain("import AdminLayout from '../layouts/AdminLayout.astro';");
    expect(body).toContain('<AdminLayout title="Status-page subscribers">');
    expect(body).toMatch(/V-312 — admin view of status-page email subscribers/);
    expect(body).toMatch(/V-295c3 \+\s*\n?\s*\/\/\s*V-295c3-tombstone/);
    expect(body).toMatch(/V-281 pattern/);
    expect(body).toMatch(
      /Email addresses subscribed to status\.driftstack\.dev incident notifications\. Confirmed\s+subscribers receive emails when public incidents are posted or resolved\. A forced\s+unsubscribe is also written to the admin audit log\./,
    );
  });

  it('uses a 51-row offset request, renders 50, and derives both paging directions from committed state', () => {
    expect(body).toContain('const PAGE_SIZE = 50;');
    expect(body).toContain('const PAGE_FETCH_LIMIT = PAGE_SIZE + 1;');
    expect(body).toContain('let requestedOffset = 0;');
    expect(body).toContain('let renderedOffset = 0;');
    expect(body).toMatch(
      /'\/v1\/admin\/status-subscribers\?limit='\s*\+\s*PAGE_FETCH_LIMIT\s*\+\s*'&offset='\s*\+\s*targetOffset/,
    );
    expect(body).toContain('const nextSubscribers = fetchedRows.slice(0, PAGE_SIZE);');
    expect(body).toContain('const nextHasNext = fetchedRows.length > PAGE_SIZE;');
    expect(body).toContain('renderedHasNext = nextHasNext;');
    expect(body).toContain(
      'const canPrevious = subscriberDataAvailable && renderedOffset > 0 && !controlsBusy;',
    );
    expect(body).toContain(
      'const canNext = subscriberDataAvailable && renderedHasNext && !controlsBusy;',
    );
    expect(body).toContain('requestedOffset = Math.max(0, offset);');
    expect(body).toContain('requestPage(renderedOffset - PAGE_SIZE);');
    expect(body).toContain('requestPage(renderedOffset + PAGE_SIZE);');
  });

  it('gives each read an offset-bearing generation owner and fences every commit/cleanup', () => {
    expect(body).toContain(
      'const owner = { generation: generation, controller: controller, offset: targetOffset };',
    );
    expect(body).toContain(
      'if (refreshOwner !== owner || generation !== refreshGeneration) return null;',
    );
    expect(body).toContain('if (refreshOwner === owner && generation === refreshGeneration) {');
    expect(body).toContain('const targetOffset = requestedOffset;');
    expect(body).toContain('generation: generation,');
    expect(body).toContain('const fetchedRows = parseSubscriberPage(body);');
  });

  it('parses all 51 complete subscriber rows before publishing offsets, controls, or list HTML', () => {
    expect(body).toContain('const SUBSCRIBER_FIELDS = [');
    for (const field of ['id', 'email', 'confirmed_at', 'unsubscribed_at', 'created_at']) {
      expect(body).toContain(`'${field}'`);
    }
    expect(body).toContain('function isSubscriber(value)');
    expect(body).toContain('SUBSCRIBER_FIELDS.every((field) => hasOwn(value, field))');
    expect(body).toContain("value.id.startsWith('sub_')");
    expect(body).toContain('EMAIL_RE.test(value.email)');
    expect(body).toContain('isIsoUtc(value.created_at)');
    expect(body).toContain('function parseSubscriberPage(body)');
    expect(body).toContain('body.data.length > PAGE_FETCH_LIMIT');
    expect(body).toContain('!body.data.every(isSubscriber)');
    expect(body).toContain("throw responseContractError('Invalid subscriber list response')");
    expect(body).toMatch(
      /function responseContractError\(message\) \{\s*const error = new Error\(message\);\s*error\.staffSafe = true;/,
    );

    const parse = body.indexOf('const fetchedRows = parseSubscriberPage(body);');
    expect(
      body.indexOf('const nextSubscribers = fetchedRows.slice(0, PAGE_SIZE);', parse),
    ).toBeGreaterThan(parse);
    expect(body.indexOf('renderedSubscribers = nextSubscribers;', parse)).toBeGreaterThan(parse);
    expect(body.indexOf('renderedOffset = targetOffset;', parse)).toBeGreaterThan(parse);
  });

  it('retains the prior page, exact retry offset, and mutation evidence on malformed refreshes', () => {
    expect(body).toContain('let renderedSubscribers = [];');
    expect(body).toContain('let preserveRenderedPage = false;');
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

  it('disables paging while reads or mutation reconciliation own the page', () => {
    expect(body).toContain(
      'const mutationReconciling = forceUnsubsInFlight.size > 0 || addInFlight;',
    );
    expect(body).toContain('const controlsBusy = readBusy || mutationReconciling;');
    expect(body).toContain(
      "previousPageBtn.title = 'Paging is unavailable while a subscriber change is reconciled.';",
    );
    expect(body).toContain(
      "nextPageBtn.title = 'Paging is unavailable while a subscriber change is reconciled.';",
    );
  });

  it('keeps force-unsubscribe on its origin and reconciles ambiguous outcomes by exact id plus unsubscribed_at', () => {
    expect(body).toContain('function mutationOutcomeIsUnknown(err)');
    expect(body).toContain('return explicitStatus >= 500;');
    expect(body).toContain('const originOffset = renderedOffset;');
    expect(body).toMatch(
      /requestedOffset = originOffset;\s*\n?\s*const reconciliation = await refreshWithLive\(\)/,
    );
    expect(body).toContain(
      'reconciliation.fetchedRows.find((subscriber) => String(subscriber.id) === id)',
    );
    expect(body).toContain('exactRow && exactRow.unsubscribed_at');
    expect(body).toContain(
      'is absent from the refreshed page slice. Absence from this slice is not evidence',
    );
    expect(body).not.toContain('active, so it likely completed');
  });

  it('treats accepted force-unsubscribe as body-independent and non-replayable', () => {
    expect(body).toContain('The response body is unused. Trust the accepted status');
    expect(body).not.toMatch(/force-unsubscribe[\s\S]{0,700}await response\.json\(\)/);
    expect(body).toContain('const committedForceUnsubs = new Set();');
    expect(body).toContain('committedForceUnsubs.add(id);');
    expect(body).toContain('committedForceUnsubs.has(id)');
  });

  it('latches an accepted force-subscribe before body parsing and validates all returned details', () => {
    expect(body).toMatch(
      /acceptedStatusCommitted = true;\s*\n?\s*const body = await response\.json\(\)\.catch\(\(\) => null\)/,
    );
    expect(body).toContain('function validForceSubscribeResult(body)');
    expect(body).toContain("typeof body.unsubscribe_link === 'string'");
    expect(body).toContain('addCommitDetailsUnavailable = true;');
    expect(body).toContain('Add subscriber committed, but result details are unavailable.');
    expect(body).toContain('requestedOffset = 0;');
    expect(body).toMatch(
      /addOutcomeUnknown \|\|\s*\n?\s*addCommitDetailsUnavailable \|\|\s*\n?\s*forceUnsubsInFlight\.size > 0 \|\|\s*\n?\s*refreshOwner !== null/,
    );
  });

  it('uses only active first-page email presence as positive ambiguous-add evidence', () => {
    expect(body).toContain('responseError.httpStatus = response.status;');
    expect(body).toContain('if (mutationOutcomeIsUnknown(err))');
    expect(body).toContain('reconciliation.offset === 0');
    expect(body).toContain('Array.isArray(reconciliation.rows)');
    expect(body).toMatch(
      /typeof subscriber\.email === 'string' &&\s*\n?\s*!subscriber\.unsubscribed_at &&\s*\n?\s*subscriber\.email\.toLowerCase\(\) === normalizedEmail/,
    );
    expect(body).toContain('absence from that page is not evidence that the add failed');
    expect(body).toContain('returned unsubscribe link cannot be recovered');
  });

  it('keeps manual and interval refreshes from superseding mutation reconciliation', () => {
    expect(body).toContain(
      "refreshBtn.title = 'Wait for the current subscriber change to finish.';",
    );
    expect(body).toMatch(
      /refreshBtn\.addEventListener\('click',[\s\S]*?if \(forceUnsubsInFlight\.size > 0 \|\| addInFlight\) return;/,
    );
    expect(body).toMatch(
      /setInterval\(function \(\) \{\s*if \(forceUnsubsInFlight\.size > 0 \|\| addInFlight\) return;\s*refreshWithLive\(\);/,
    );
  });

  it('keeps nullable-email tombstones as rows without a destructive action', () => {
    expect(body).toContain('const canForceUnsub = !sub.unsubscribed_at && sub.email;');
    expect(body).toContain('(purged after retention period)');
    expect(body).toContain('<span class="text-xs text-tk-ink-3">no action</span>');
    expect(body).toContain("'<li data-subscriber-id=\"' +");
    expect(body).not.toMatch(/filter\([^\n]*sub\.email/);
  });

  it('renders all three lifecycle badges and preserves XSS-safe helpers', () => {
    expect(body).toContain('>confirmed</span>');
    expect(body).toContain('>pending</span>');
    expect(body).toContain('>unsubscribed ');
    expect(body).toMatch(/function escapeHtml\(s\)/);
    expect(body).toMatch(/\.replace\(\/\[&<>"'\]\/g/);
    expect(body).toMatch(
      /new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC'/,
    );
  });

  it('preserves staff auth, API-origin prefixing, and the shared 15-second deadline', () => {
    expect(body).toContain("localStorage.getItem('ds_web_session_token')");
    expect(body).toContain("authorization: 'Bearer ' + token");
    expect(body).toContain('const SUBSCRIBER_TIMEOUT_MS = 15_000;');
    expect(body).toContain(
      'window.driftstackFetchWithDeadline(url, init, SUBSCRIBER_TIMEOUT_MS, controller)',
    );
    expect(body).not.toMatch(/\bfetch\(/);
    expect(body).toMatch(/<script is:inline define:vars=\{\{ apiBaseUrl \}\}>/);
  });

  it('keeps neutral auth, empty, banner, and footer copy', () => {
    expect(body).toContain('data-live-status>Waiting for live data</span>');
    expect(body).toContain('Sign in with a staff admin account to load subscribers.');
    expect(body).toContain('No subscribers yet');
    expect(body).toContain(
      'When visitors subscribe to incident notifications on status.driftstack.dev, they appear here',
    );
    expect(body).toMatch(/data-banner/);
    expect(body).toMatch(/role="status"/);
    expect(body).toContain("banner.classList.add('border-red-200', 'bg-red-50', 'text-red-700')");
    expect(body).toMatch(
      /Subscribers list paginated server-side \(default 50 per page; <code>\?limit=&amp;offset=<\/code>/,
    );
    expect(body).toMatch(/Tombstoned rows appear with email = <code>null<\/code> after/);
  });
});
