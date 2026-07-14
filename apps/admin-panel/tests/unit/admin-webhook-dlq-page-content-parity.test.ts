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
    expect(body).toContain('/v1/admin/webhook-dlq?limit=50');
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

  it('CRITICAL discard confirm is destructive:true — without it the OK button auto-focuses and a stray Enter fires the irrecoverable hard-delete with no click required (audit waefer6wu)', () => {
    const discardFn = body.match(/async function discard\(id\)[\s\S]*?\n      \}/);
    expect(discardFn).not.toBeNull();
    const fn = discardFn![0]!;
    expect(fn).toMatch(/window\.driftstackConfirm\(/);
    const confirmCall = fn.match(/window\.driftstackConfirm\([\s\S]*?\);/);
    expect(confirmCall).not.toBeNull();
    expect(confirmCall![0]).toMatch(/destructive:\s*true/);
  });

  it('requeue/discard failures surface the server problem+json detail via mutationError (W151/W152)', () => {
    // Concurrent operators on a shared DLQ can race; a refused
    // requeue/discard ("already requeued", "already discarded") must
    // explain itself rather than show a bare "HTTP 409". Pin the helper +
    // both mutations routing through it (the load fetch keeps its own
    // graceful fallback and is unaffected).
    expect(body).toMatch(/function mutationError\(r\)/);
    expect(body).toMatch(/window\.driftstackResponseError\(r, b\)/);
    const usages = body.match(/r\.ok \? r\.json\(\) : mutationError\(r\)/g) ?? [];
    expect(usages.length).toBe(2);
  });

  it('reconciles ambiguous requeue/discard row removals before any retry', () => {
    expect(body).toContain('Requeue outcome is unknown after the request timed out.');
    expect(body).toContain('it was likely re-enqueued; do not submit it again.');
    expect(body).toContain('Discard outcome is unknown after the request timed out.');
    expect(body).toContain('only its audit trace remains; do not submit it again.');
    expect(body).toMatch(/const refreshed = await load\(\)/);
  });
});
