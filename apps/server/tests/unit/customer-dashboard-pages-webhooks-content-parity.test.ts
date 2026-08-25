// W497.B — drift guard for apps/customer-dashboard/src/pages/webhooks.astro.
// V-181 + V-347 + V-351b + V-359 + V-403 + V-443 + V-475 + V-356
// webhooks page. Drift here either drops the V-475 in-page secret
// reveal (would revert to window.prompt — blocked in incognito) or
// breaks the V-403/V-443 delivery-log filter + cursor pagination
// (customers couldn't drill into per-status delivery history).
//
//   • V-181 progressive-enhancement framing.
//   • V-347 create-form + secret-shown-ONCE reveal.
//   • V-475 in-page rotate-secret reveal pane (replaces window.prompt).
//   • V-351b PATCH-style edit form with active toggle.
//   • V-359 rotation_grace_expires_at indicator + 24h grace framing.
//   • V-403 + V-443 delivery-log filter (6 status) + cursor pagination.
//   • V-356 send-test endpoint with 202-success.
//   • 5-event subscribe enum: session.completed/session.failed/
//     api_key.revoked/quota.warning_80pct/quota.exceeded.
//   • HMAC-SHA256 + 5-min timestamp tolerance framing.
//   • Retry 5× exponential backoff + DLQ + no-auto-retry framing.
//   • V-331b act-as header in all writes.
//   • POST + PATCH + DELETE + /:id/rotate-secret + /:id/test +
//     /:id/deliveries + /webhook-deliveries/:id/replay contracts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W497.B apps/customer-dashboard/src/pages/webhooks.astro content parity', () => {
  const body = read(LIB);

  it("V-181 framing pinned: 'progressive-enhancement wiring against /v1/webhooks, mirrors V-180 /sessions pattern. SSR renders loading skeletons for instant paint (S32: the mock was never rendered and was removed); inline <script> replaces them with live data.' — pinned so the skeleton + live-replace pattern + the cross-page V-180 sessions consistency reference survive. Re-enabled by slice 157 after verifying the V-181 comment still exists at webhooks.astro:4-7 with the matching shape", () => {
    // S32 2026-07-07 (fable-frontend-audit) — the page never rendered a mock (skeletons only);
    // the doc-block now says so and the dead MOCK_WEBHOOKS was removed.
    expect(body).toMatch(
      /\/\/ V-181 — progressive-enhancement wiring against \/v1\/webhooks,\s*\/\/ mirrors V-180 \/sessions pattern\. SSR renders loading skeletons for\s*\/\/ instant paint; the inline <script> below replaces them with live/,
    );
  });

  it('Delivery-counts framing pinned (S32: live counts shipped via V-185; coming-soon block removed): \'Live /v1/webhooks response shape DOES include endpoint metadata (URL, events, active, description, consecutive_failures, last_success_at, last_failure_at, created_at) but does NOT include aggregate delivery_counts (delivered/failed/dlq). The mock displays delivery_counts; in live mode we render dashes for those cells and surface a note ("Delivery counts coming soon"). Adding a delivery-aggregation endpoint is a separate V-NNN.\' — pinned so the mock-vs-live shape divergence stays documented (drift to claiming live counts work would mislead customers reading the page comments)', () => {
    // S32 2026-07-07 (fable-frontend-audit) — V-185 added the real delivery_counts, so the
    // "coming soon"/"not exposed" framing became false and was removed.
    expect(body).toMatch(/delivery_counts to \/v1\/webhooks/);
    expect(body).toMatch(/the cards render live counts/);
    expect(body).not.toMatch(/Delivery counts coming soon/);
  });

  it('V-475 in-page rotate-secret reveal framing pinned. Re-enabled by slice 276 after restoring the V-475 anchor on the HTML comment at webhooks.astro:211 (anchor stripped to bare-em-dash + bare-space-indentation)', () => {
    expect(body).toMatch(
      /V-475 — rotate-secret in-page reveal\. Replaces the window\.prompt\s*shown in earlier slices; some browsers block prompts in\s*non-interactive contexts \(incognito, autofill blockers, etc\.\)\./,
    );
  });

  it("HMAC-SHA256 + 5-min timestamp tolerance framing pinned: 'HMAC-SHA256-signed event delivery · 5-minute timestamp tolerance' — pinned so the signature algorithm + replay window stay explicit (drift to dropping HMAC-SHA256 would let customers wonder which signature scheme to verify against; drift to dropping 5-min tolerance would lose the replay-attack window framing)", () => {
    expect(body).toMatch(/HMAC-SHA256-signed event delivery · 5-minute timestamp tolerance/);
  });

  it('8-event emitted subscribe enum is rendered in create/edit; session.completed stays default-checked and silent quota subscriptions stay absent', () => {
    expect(body).toMatch(/<input type="checkbox" name="event" value="session\.completed" checked/);
    expect(body).toMatch(/<input type="checkbox" name="event" value="session\.failed"/);
    expect(body).toMatch(/<input type="checkbox" name="event" value="api_key\.revoked"/);
    expect(body).toMatch(
      /<input type="checkbox" name="event" value="session\.egress_capability_changed"/,
    );
    expect(body).toMatch(/<input type="checkbox" name="event" value="crypto\.order\.paid"/);
    expect(body).toMatch(/<input type="checkbox" name="event" value="crypto\.order\.failed"/);
    expect(body).toMatch(/<input type="checkbox" name="event" value="session\.challenge_detected"/);
    expect(body).toMatch(
      /<input type="checkbox" name="event" value="session\.profile_save_failed"/,
    );
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it('V-403 + V-443 delivery-log framing pinned. Re-enabled by slice 211 after verifying the per-endpoint pager Map + filter-resets-cursor framing exists verbatim at webhooks.astro:783-789', () => {
    expect(body).toMatch(
      /\/\/ V-403 \+ V-443 — delivery-log status filter \+ cursor pagination\.\s*\/\/ Backend accepts \?status= \+ \?cursor= on \/v1\/webhooks\/:id\/deliveries\.\s*\/\/ V-443 stores a `cursor` per endpoint in a closure-scoped Map/,
    );
    expect(body).toMatch(/const deliveriesPager = new Map\(\);/);
  });

  it('V-403 6-status filter enum pinned. Re-enabled by slice 211 after verifying the 6-status array exists verbatim at webhooks.astro:803', () => {
    expect(body).toMatch(/\['', 'pending', 'in_flight', 'delivered', 'failed', 'dlq'\]/);
  });

  it("V-347 secret-shown-ONCE + verifyWebhookSignature helper-name framing pinned. Re-enabled by slice 211 after verifying the 'Copy this signing secret now…verifyWebhookSignature helper to authenticate incoming deliveries.' copy exists at webhooks.astro:193-196", () => {
    expect(body).toMatch(
      /Copy this signing secret now — it won't be shown again\. Use it with the SDK's\s*<code class="font-mono">verifyWebhookSignature<\/code> helper to authenticate\s*incoming deliveries\./,
    );
  });

  it('V-359 rotation 24h grace framing pinned. Re-enabled by slice 229 after verifying both halves still exist (confirm prompt at webhooks.astro:1253-1255 + rotation-in-flight indicator comment at webhooks.astro:659-662)', () => {
    expect(body).toMatch(
      /'Rotate signing secret for ' \+\s*id \+\s*'\?\\n\\nThe new secret is shown ONCE\. The old secret stays active for 24h so your verifier can roll forward without dropped deliveries\.',/,
    );
    expect(body).toMatch(
      /\/\/ V-359 — rotation-in-flight indicator\. When the endpoint is\s*\/\/ dual-signing, surface the grace expiry inline so customers\s*\/\/ know how long they have to roll the new secret across\s*\/\/ their verifier infra\./,
    );
  });

  it('Webhook API contracts: POST /v1/webhooks + PATCH /v1/webhooks/:id + DELETE /v1/webhooks/:id + POST /v1/webhooks/:id/rotate-secret + POST /v1/webhooks/:id/test + GET /v1/webhooks/:id/deliveries + POST /v1/webhook-deliveries/:id/replay — pinned so the 7-endpoint webhook lifecycle contract stays correct (drift to renaming any path would break the wired UI action)', () => {
    expect(body).toMatch(/boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks', \{\s*method: 'POST',/);
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(editingEndpointId\), \{\s*method: 'PATCH',/,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\), \{\s*method: 'DELETE',/,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\) \+ '\/rotate-secret', \{\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\) \+ '\/test', \{\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /apiBaseUrl \+\s*'\/v1\/webhooks\/' \+\s*encodeURIComponent\(endpointId\) \+\s*'\/deliveries\?'/,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhook-deliveries\/' \+ encodeURIComponent\(id\) \+ '\/replay', \{\s*method: 'POST',/,
    );
    expect(body).toMatch(/const WEBHOOK_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/window\.driftstackFetchWithDeadline\(url, init, WEBHOOK_TIMEOUT_MS\)/);
    expect(body).toMatch(/const endpointMutationIdsInFlight = new Set\(\);/);
    expect(body).toMatch(/const actionButtonsInFlight = new WeakSet\(\);/);
    expect(body).toMatch(/const uncertainRotationIds = new Set\(\);/);
    expect(body).toMatch(/const uncertainTestEndpointIds = new Set\(\);/);
    expect(body).toMatch(/const uncertainReplayIds = new Set\(\);/);
  });

  it("V-356 send-test framing pinned: 'wire the per-row \"Send test\" buttons. POSTs to /v1/webhooks/:id/test which enqueues a synthetic test.ping delivery on the endpoint regardless of subscription.' + 202-or-r.ok success branch — pinned so the test-delivery 'bypasses subscription filter' semantic survives (drift to requiring subscription would block test-pings on production endpoints subscribed to only quota events). Re-enabled by slice 157 after verifying both sentinels exist at webhooks.astro:1296-1298 + :1318", () => {
    expect(body).toMatch(
      /\/\/ V-356 — wire the per-row "Send test" buttons\. POSTs to\s*\/\/ \/v1\/webhooks\/:id\/test which enqueues a synthetic test\.ping\s*\/\/ delivery on the endpoint regardless of subscription\./,
    );
    expect(body).toMatch(/if \(!r\.ok && r\.status !== 202\) \{/);
  });

  it("Retry + DLQ framing pinned: 'Failed deliveries retry 5× with exponential backoff before landing in the DLQ. DLQ entries are admin-replayable; no auto-retry past the initial attempts to avoid storm-on-recovery patterns.' — pinned so the 5× retry budget + the no-auto-retry-past-budget storm-prevention framing both survive (drift to dropping 'storm-on-recovery' would hide WHY auto-retry doesn't continue past 5 attempts)", () => {
    expect(body).toMatch(
      /Failed deliveries retry 5× with exponential backoff before landing in\s*the DLQ\. DLQ entries are admin-replayable; no auto-retry past the\s*initial attempts to avoid storm-on-recovery patterns\./,
    );
  });

  it("V-475 plaintext-wipe-on-dismiss framing pinned: 'Clear secret from DOM so it isn't recoverable post-dismiss.' + rotateSecretEl.textContent = '' on hide — pinned so the post-dismiss DOM wipe survives (drift to leaving the secret in the DOM would let post-dismiss page inspectors recover the rotated secret, defeating the shown-ONCE contract). Re-enabled by slice 157 after verifying both sentinels exist at webhooks.astro:1213-1214", () => {
    expect(body).toMatch(/\/\/ Clear secret from DOM so it isn't recoverable post-dismiss\./);
    expect(body).toMatch(/rotateSecretEl\.textContent = '';/);
  });

  it("HTTPS-required + 10s 2xx framing pinned: 'HTTPS required. The endpoint must respond 2xx within 10s for delivery to count as successful.' — pinned so the protocol requirement + response-time budget stay explicit (drift to dropping HTTPS would let customers register HTTP endpoints that fail with cryptic 'TLS required' errors; drift to dropping 10s would leave customers wondering why their slow webhooks land in DLQ)", () => {
    expect(body).toMatch(
      /HTTPS required\. The endpoint must respond 2xx within 10s for delivery to count\s*as successful\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
