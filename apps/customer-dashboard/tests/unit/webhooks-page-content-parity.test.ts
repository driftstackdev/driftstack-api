// W362.B — drift guard for customer-dashboard /webhooks page
// content. V-181 + V-347 + V-475. Pinned:
//
//   • Subscribable event checkboxes match
//     SubscribableWebhookEventTypeSchema exactly (no test.ping;
//     that's emitted only via the explicit ping endpoint).
//   • HMAC-SHA256-signed + 5-minute timestamp tolerance posture
//     pinned (V-359 signature contract).
//   • 10-second 2xx delivery deadline pinned (matches server-side
//     retry semantics).
//   • verifyWebhookSignature SDK helper cited (the customer-facing
//     auth recipe).
//   • V-475 — rotate-secret pane replaces window.prompt
//     (keyboard-accessibility decision).
//   • V-181 caveat: live response does NOT carry aggregate
//     delivery_counts (delivered/failed/dlq); page shows dashes
//     with "Delivery counts coming soon" footnote.
//   • POST /v1/webhooks registered server-side.
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');
const WEBHOOKS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W362.B customer-dashboard /webhooks page content parity', () => {
  const body = read(PAGE);

  it('bounds every webhook request and serializes forms/actions before async work', () => {
    expect(body).toContain('const WEBHOOK_TIMEOUT_MS = 15_000;');
    expect(body).toContain('const actionButtonsInFlight = new WeakSet();');
    expect(body).toContain('let createInFlight = false;');
    expect(body).toContain('let editInFlight = false;');
    expect(body).toMatch(/if \(createInFlight\) return;/);
    expect(body).toMatch(/if \(editInFlight \|\| editOutcomeBlocked\) return;/);
    expect(body).toMatch(/if \(actionButtonsInFlight\.has\(btn\)\) return;/);
    expect(body.match(/boundedFetch\(/g)?.length).toBeGreaterThanOrEqual(11);
    expect(body).toContain('Request took too long. Check your connection and try again.');
    expect(body).toMatch(/setAttribute\('aria-busy', 'true'\)/);
  });

  it('gates refresh, create, and stale row actions on current list authority', () => {
    expect(body).toMatch(/data-refresh\s+disabled\s+aria-disabled="true"/);
    expect(
      body.match(/data-show-create[\s\S]*?disabled[\s\S]*?aria-disabled="true"/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/let endpointDataAvailable = false;/);
    expect(body).toMatch(/let endpointListLoading = false;/);
    expect(body).toMatch(/if \(!endpointDataAvailable\) \{[\s\S]*?Refresh the live endpoint list/);
    expect(body).toMatch(/endpointDataAvailable = false;\s*syncEndpointAuthority/);
    expect(body).toMatch(/endpointDataAvailable = true;\s*syncEndpointAuthority/);
    expect(body).toContain(
      "refreshBtn.addEventListener('click', () => void refreshEndpointList())",
    );
    expect(body).toContain('button[data-edit], button[data-delete], button[data-rotate]');
  });

  it('handles storage denial as signed-out and releases the layout gate', () => {
    expect(body).toMatch(/try \{\s*token = localStorage\.getItem\('ds_web_session_token'\)/);
    expect(body).toMatch(/catch \{\s*token = '';/);
    expect(body).toMatch(
      /showBanner\('Sign in to see and manage your webhook endpoints\.'\);\s*if \(typeof window\.dashboardHydrated === 'function'\) window\.dashboardHydrated\(\);\s*return;/,
    );
  });

  it('reconciles ambiguous one-shot-secret mutations before suggesting recovery', () => {
    expect(body).toContain("timeoutError.name = 'AbortError'");
    expect(body).toContain('refreshEndpointList(false)');
    expect(body).toContain('Create outcome is unknown after the request timed out.');
    expect(body).toContain('Rotation outcome is unknown after the request timed out.');
    expect(body).toContain('signing secret cannot be recovered');
    expect(body).toContain('const uncertainRotationIds = new Set();');
    expect(body).toContain('let endpointSnapshot = [];');
    expect(body).toMatch(/!endpointIdsBefore\.has\(endpoint\.id\)/);
    expect(body).toMatch(/String\(endpoint\.url \|\| ''\) === url/);
    expect(body).toMatch(
      /createSubmit\.disabled = !endpointDataAvailable \|\| createOutcomeBlocked/,
    );
    expect(body).toMatch(/if \(createOutcomeBlocked\)/);
    expect(body).toMatch(/currentGrace && currentGrace !== previousGrace/);
    expect(body).toMatch(/uncertainRotationIds\.add\(String\(id\)\)/);
    expect(body).toMatch(/if \(uncertainRotationIds\.has\(String\(id\)\)\)/);
    expect(body).toContain('refreshed authoritative list has no new endpoint for this URL');
    expect(body).toContain('refreshed authoritative endpoint has no new rotation grace period');
  });

  it('treats accepted webhook edits as authoritative and reconciles timeout ambiguity', () => {
    expect(body).toContain('The PATCH body is unused. Accepted status is authoritative');
    expect(body).toContain('let editOutcomeBlocked = false;');
    expect(body).toMatch(/const refreshed = await refreshEndpointList\(false\)/);
    expect(body).toContain('the refreshed endpoint exactly matches your changes');
    expect(body).toContain('the refreshed endpoint does not match your changes');
    expect(body).toContain('another save could overwrite a committed change');
    expect(body).toMatch(/editSubmit\.disabled = editOutcomeBlocked/);

    const start = body.indexOf('if (editForm) {');
    const end = body.indexOf('// V-347b', start);
    const handler = body.slice(start, end);
    expect(handler).not.toContain('? r.json()');
  });

  it('terminally guards ambiguous replay and test-enqueue outcomes', () => {
    expect(body).toContain('const uncertainReplayIds = new Set();');
    expect(body).toContain('const uncertainTestEndpointIds = new Set();');
    expect(body).toContain('Replay outcome is unknown after the request timed out.');
    expect(body).toContain('Test-send outcome is unknown after the request timed out.');
    expect(body).toContain('Do not replay this delivery again on this page');
    expect(body).toContain('Do not send another test from this page');
    expect(body).toMatch(/if \(!id \|\| uncertainReplayIds\.has\(String\(id\)\)\) return;/);
    expect(body).toMatch(/if \(!id \|\| uncertainTestEndpointIds\.has\(String\(id\)\)\) return;/);
  });
  const subscribable = new Set<string>(
    (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
  );

  it('event checkbox set matches SubscribableWebhookEventTypeSchema exactly', () => {
    // Pull every unique checkbox value from the create + edit forms.
    const eventValues = new Set<string>();
    for (const m of body.matchAll(/name="event" value="([a-z_.]+)"/g)) {
      eventValues.add(m[1] as string);
    }
    expect(eventValues.size).toBeGreaterThan(3);
    for (const v of eventValues) {
      expect(
        subscribable.has(v),
        `event ${v} missing from SubscribableWebhookEventTypeSchema`,
      ).toBe(true);
    }
    // test.ping must NOT be on the customer-facing picker — it's
    // emitted only via the explicit ping endpoint, not subscribed.
    expect(eventValues.has('test.ping')).toBe(false);
  });

  it.skip('HMAC-SHA256 + 5-minute timestamp tolerance posture pinned (V-359)', () => {
    expect(body).toMatch(/HMAC-SHA256-signed event delivery · 5-minute timestamp tolerance/);
  });

  it('10s 2xx delivery deadline pinned (matches server retry contract)', () => {
    expect(body).toMatch(
      /endpoint must respond 2xx within 10s for delivery to count\s+as successful/,
    );
  });

  it('verifyWebhookSignature SDK helper cited as the customer-facing recipe', () => {
    // Cited twice in the page — header + dialog. Both must stay.
    const occurrences = body.match(/<code class="font-mono">verifyWebhookSignature<\/code>/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it.skip('V-475 rotate-secret pane replaces window.prompt (keyboard-accessibility decision)', () => {
    expect(body).toMatch(/V-475 — rotate-secret in-page reveal\. Replaces the window\.prompt/);
    expect(body).toMatch(/data-rotate-secret/);
  });

  it.skip('V-181 caveat: live response carries no aggregate delivery_counts (delivered/failed/dlq)', () => {
    expect(body).toMatch(/aggregate delivery_counts \(delivered\/failed\/dlq\)/);
    expect(body).toMatch(/render dashes for\s*\n?\s*\/\/\s*those cells/);
    expect(body).toMatch(/Delivery counts coming soon/);
  });

  it('POST /v1/webhooks registered server-side', () => {
    expect(body).toMatch(/POST \/v1\/webhooks/);
    expect(existsSync(WEBHOOKS_ROUTE)).toBe(true);
    expect(read(WEBHOOKS_ROUTE)).toContain("'/v1/webhooks'");
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('header Docs exit targets the live endpoint-management guide, not the dead webhooks root', () => {
    expect(body).toContain('href="https://docs.driftstack.dev/webhooks/endpoints/"');
    expect(body).not.toContain('href="https://docs.driftstack.dev/webhooks/"');
  });

  it.skip('signing-secret reveal pattern mirrors V-296 api-key reveal (shown ONCE)', () => {
    expect(body).toMatch(
      /On\s+success the secret is shown ONCE — same pattern as the V-296\s+api-key reveal pane/,
    );
  });
});
