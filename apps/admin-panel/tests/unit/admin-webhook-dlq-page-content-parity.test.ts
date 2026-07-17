// W360.C — drift guard for admin-panel /webhook-dlq page content.
// V-189 progressive-enhancement against /v1/admin/webhook-dlq +
// /v1/admin/webhook-dlq/:id/requeue. Pinned:
//
//   • GET /v1/admin/webhook-dlq + POST .../requeue both
//     registered server-side.
//   • Retry budget "5×" claim pinned — this is the
//     customer-facing operational expectation; it must match
//     the actual cap (AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES /
//     the retry-schedule constant).
//   • "Manual intervention only — auto-retry past initial
//     attempts is intentionally absent" stance pinned (V-189
//     storm-on-recovery decision).
//   • Requeue copy: "delivery resets to attempt=1 + retry
//     budget refreshes" pinned ↔ server-side reset semantics.
//   • Audit-log claim: "admin id + delivery id + reason" stays
//     pinned (matches webhook_delivery.requeued admin-audit
//     action).
//   • localStorage key ds_web_session_token (admin convention).
//   • V-189 caveat ("account email + webhook URL aren't part of
//     the DLQ delivery shape today") pinned as a load-bearing
//     breadcrumb for future schema work.
//   • Healthy-posture empty-state copy pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/webhook-dlq.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W360.C admin-panel /webhook-dlq page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/admin/webhook-dlq + POST .../requeue both registered server-side', () => {
    expect(body).toContain("params.set('limit', '50')");
    expect(body).toContain("if (requestedCursor) params.set('cursor', requestedCursor)");
    expect(body).toContain("'/v1/admin/webhook-dlq?' + params.toString()");
    expect(body).toMatch(/POST \/v1\/admin\/webhook-dlq\/:id\/requeue/);
    expect(existsSync(ROUTE)).toBe(true);
    expect(route).toContain("'/v1/admin/webhook-dlq'");
    expect(route).toContain("'/v1/admin/webhook-dlq/:id/requeue'");
  });

  it('retry-budget "5×" claim pinned (matches server-side cap)', () => {
    expect(body).toMatch(/exhausted the retry budget \(5×\)/);
  });

  it('"manual-intervention-only" stance pinned (V-189 storm-on-recovery decision)', () => {
    expect(body).toMatch(
      /Manual intervention\s+only — auto-retry past the initial attempts is intentionally absent\s+to avoid storm-on-recovery patterns/,
    );
  });

  it('requeue resets attempt=1 + budget framing pinned', () => {
    expect(body).toMatch(
      /Requeue fires <code class="font-mono">POST \/v1\/admin\/webhook-dlq\/:id\/requeue<\/code>\s*—\s*delivery resets to attempt=1 \+ retry budget refreshes/,
    );
  });

  it('audit-log row claim pinned (admin id + delivery id + reason) ↔ webhook_delivery.requeued action', () => {
    expect(body).toMatch(/Audit row records\s+admin id \+ delivery id \+ reason/);
    expect(route).toContain("'webhook_delivery.requeued'");
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain("'ds_web_session_token'");
    expect(body).toMatch(
      /try\s*\{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch\s*\{\s*token = null;/,
    );
  });

  it('V-189 enriched-display caveat pinned (account email + webhook URL not in DLQ shape today)', () => {
    // The comment is the load-bearing breadcrumb for a future
    // slice that adds the join. Without this caveat pinned a
    // future refactor might silently start displaying stale or
    // wrong owner info.
    expect(body).toMatch(
      /Account email \+ webhook URL\s*\n?\s*\/\/\s*aren't part of the DLQ delivery shape today/,
    );
  });

  it('empty-state copy stays pinned (healthy posture framing)', () => {
    expect(body).toMatch(/DLQ empty/);
    expect(body).toMatch(/Healthy posture —\s+customer endpoints are reachable \+ responding/);
  });

  it('requeue button triggers POST + page wires to client requeue() handler', () => {
    expect(body).toMatch(/data-action="requeue"/);
    expect(body).toMatch(/function requeue\(id\)/);
  });

  it('walks the opaque cursor without losing, duplicating, or stale-appending operator rows', () => {
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toMatch(/let loadedEntries = \[\];/);
    expect(body).toMatch(/let nextCursor = null;/);
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/let appendInFlight = false;/);
    expect(body).toMatch(/let expandedView = false;/);
    expect(body).toMatch(/function mergeUniqueEntries\(existing, incoming\)/);
    expect(body).toMatch(/if \(!id \|\| seen\.has\(id\)\) return;/);
    expect(body).toMatch(/const requestedCursor = append \? nextCursor : null;/);
    expect(body).toMatch(/if \(append && \(!requestedCursor \|\| appendInFlight\)\)/);
    expect(body).toMatch(/const epoch = append \? listEpoch : \+\+listEpoch;/);
    expect(body).toMatch(/if \(myReq !== inFlight \|\| epoch !== listEpoch\) return false;/);
    expect(body).toMatch(/if \(append && nextCursor !== requestedCursor\) return false;/);
    expect(body).toMatch(
      /const nextLoadedEntries = append\s*\? mergeUniqueEntries\(loadedEntries, page\.entries\)\s*: mergeUniqueEntries\(\[\], page\.entries\);/,
    );
    expect(body).toContain('loadedEntries = nextLoadedEntries;');
  });

  it('validates the complete route row and explicit cursor before any authoritative state commit', () => {
    expect(body).toContain("import { WebhookEventTypeSchema } from '@driftstack/api-types';");
    expect(body).toContain('const webhookEventTypes = WebhookEventTypeSchema.options;');
    expect(body).toContain('define:vars={{ apiBaseUrl, webhookEventTypes }}');
    expect(body).toContain('const allowedWebhookEventTypes = new Set(webhookEventTypes);');
    expect(body).toContain('function isDelivery(value)');
    for (const field of [
      'id',
      'webhook_id',
      'event_id',
      'event_type',
      'status',
      'attempts',
      'next_attempt_at',
      'last_response_status',
      'last_response_excerpt',
      'last_error',
      'delivered_at',
      'created_at',
    ]) {
      expect(body).toContain(`'${field}'`);
    }
    expect(body).toContain("value.id.startsWith('wdl_')");
    expect(body).toContain("value.webhook_id.startsWith('whk_')");
    expect(body).toContain('allowedWebhookEventTypes.has(value.event_type)');
    expect(body).toContain("value.status === 'dlq'");
    expect(body).toContain('Number.isInteger(value.attempts)');
    expect(body).toContain('function parseDlqPage(body)');
    expect(body).toContain("!hasOwn(body, 'data')");
    expect(body).toContain('body.data.length > 50');
    expect(body).toContain('!body.data.every(isDelivery)');
    expect(body).toContain("!hasOwn(body, 'next_cursor')");
    expect(body).toContain("typeof body.next_cursor === 'string' && body.next_cursor.length > 0");
    expect(body).toContain("throw responseContractError('Invalid DLQ response')");
    expect(body).toMatch(
      /function responseContractError\(message\) \{\s*const error = new Error\(message\);\s*error\.staffSafe = true;/,
    );

    const parse = body.indexOf('const page = parseDlqPage(body);');
    const rowsCommit = body.indexOf('loadedEntries = nextLoadedEntries;', parse);
    const cursorCommit = body.indexOf('nextCursor = page.nextCursor;', parse);
    expect(parse).toBeGreaterThan(-1);
    expect(rowsCommit).toBeGreaterThan(parse);
    expect(cursorCommit).toBeGreaterThan(parse);
  });

  it('keeps append failures retryable and pauses newest-page polling until an explicit reset', () => {
    expect(body).toContain('Showing 0 entries — more available');
    expect(body).toContain("(nextCursor ? ' — more available' : '')");
    expect(body).toContain("Couldn't load older DLQ entries (");
    expect(body).toContain('Existing rows are unchanged, and the retry cursor is unchanged.');
    expect(body).toContain("Couldn't refresh DLQ (");
    expect(body).toContain('Existing rows and pagination state are unchanged; retry when ready.');
    expect(body).toMatch(/if \(append\) \{\s*appendInFlight = true;\s*expandedView = true;/);
    expect(body).toMatch(/if \(hasLoadedWindow\) \{\s*renderEntries\(loadedEntries\);/);
    expect(body).toMatch(/function loadOlder\(\)[\s\S]*?load\(\{ append: true \}\)/);
    expect(body).toContain(
      "setLiveState('paused', 'Live refresh paused while viewing older entries')",
    );
    expect(body).toMatch(
      /setInterval\(\(\) => \{\s*if \(expandedView\) \{\s*showExpandedPause\(\);\s*return;/,
    );
    expect(body).toMatch(
      /const backToNewest = target\.closest\('\[data-action="back-to-newest"\]'\);[\s\S]*?loadWithLive\(\);/,
    );
    expect(body).toMatch(
      /loadMoreBtn\.disabled = readBusy \|\| appendInFlight \|\| mutationBusy \|\| !nextCursor;/,
    );
  });

  it('CRITICAL discard confirm is destructive:true — without it the OK button auto-focuses and a stray Enter fires the irrecoverable hard-delete with no click required (audit waefer6wu)', () => {
    const discardFn = body.match(/async function discard\(id\)[\s\S]*?\n      \}/);
    expect(discardFn).not.toBeNull();
    const fn = discardFn![0]!;
    expect(fn).toMatch(/window\.driftstackConfirm\(/);
    const confirmCall = fn.match(/window\.driftstackConfirm\([\s\S]*?\);/);
    expect(confirmCall).not.toBeNull();
    expect(confirmCall![0]).toMatch(/destructive:\s*true/);
  });

  it('requeue/discard non-2xx failures retain typed problem detail while accepted responses never parse unused JSON', () => {
    // Concurrent operators on a shared DLQ can race; a refused
    // requeue/discard ("already requeued", "already discarded") must
    // explain itself rather than show a bare "HTTP 409". Pin the helper +
    // both mutations route only non-2xx responses through it. A successful
    // mutation is already authoritative and must not parse an unused body that
    // could fail after the one-time action committed.
    expect(body).toMatch(/function mutationError\(r\)/);
    expect(body).toMatch(/window\.driftstackResponseError\(r, b\)/);
    expect(body).toMatch(/if \(r\.ok\) return;\s*return mutationError\(r\);/);
    expect(body).toContain('if (!r.ok) await mutationError(r);');
    expect(body).not.toContain('r.ok ? r.json() : mutationError(r)');
  });

  it('reconciles ambiguous requeue/discard row removals before any retry', () => {
    expect(body).toContain('Requeue outcome is unknown after the request timed out.');
    expect(body).toContain('it was likely re-enqueued; do not submit it again.');
    expect(body).toContain('Discard outcome is unknown after the request timed out.');
    expect(body).toContain('only its audit trace remains; do not submit it again.');
    expect(body).toMatch(/const refreshed = await load\(\)/);
  });
});
