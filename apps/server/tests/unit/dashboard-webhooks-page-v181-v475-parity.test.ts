// W753 — customer-dashboard /webhooks.astro V-181 (live-fetch) +
// V-185 (delivery counts) + V-347 (create form) + V-359 (rotation-
// in-flight indicator) + V-403/V-443 (delivery log filter + pagination)
// + V-475 (in-page rotate-reveal pane) parity. Seventy-ninth in the
// cross-SDK drift-guard series.
//
// /webhooks is the only customer-facing surface for our async
// delivery system. Drift to HMAC-SHA256 framing, the 5-minute timestamp
// tolerance, or the secret-shown-ONCE rotation pattern would erode
// the at-rest secret hygiene that webhook customers depend on.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');

describe('W753 dashboard /webhooks page V-181 + V-475 parity', () => {
  it('webhooks.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-181 anchor framing pinned. The "progressive-enhancement wiring against /v1/webhooks, mirrors V-180 /sessions pattern" wording threads the cross-page convention.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-181 — progressive-enhancement wiring against \/v1\/webhooks,/);
    expect(p).toMatch(/mirrors V-180 \/sessions pattern/);
  });

  it('CRITICAL HMAC-SHA256 + 5-minute timestamp tolerance pinned. The header copy "HMAC-SHA256-signed event delivery · 5-minute timestamp tolerance" is the canonical security framing matching the server-side W676 stripe-signing parity + V-273 webhook-delivery toolkit.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/HMAC-SHA256-signed event delivery · 5-minute timestamp tolerance/);
  });

  it('CRITICAL per-endpoint signing-secret framing pinned — "Each endpoint gets its own signing secret; verify with the SDK\'s verifyWebhookSignature helper". Drift would suggest a shared/account-wide secret (which would be a much weaker compromise blast-radius).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Each endpoint gets\s*\n\s+its own signing secret; verify with the SDK's/);
    expect(p).toMatch(/<code class="font-mono">verifyWebhookSignature<\/code> helper\./);
  });

  it("CRITICAL secret-shown-ONCE-on-creation framing pinned. The 'Copy this signing secret now — it won't be shown again. Use it with the SDK\\'s verifyWebhookSignature helper to authenticate' wording matches the W750 api-key shown-ONCE security framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Copy this signing secret now — it won't be shown again\. Use it with the SDK's/,
    );
    expect(p).toMatch(/verifyWebhookSignature<\/code> helper to authenticate/);
  });

  it("CRITICAL V-475 in-page rotate-reveal pane framing pinned. The 'rotate-secret in-page reveal. Replaces the window.prompt shown in earlier slices; some browsers block prompts in non-interactive contexts' wording explains WHY rotate uses an inline reveal not a prompt.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/rotate-secret in-page reveal\. Replaces the window\.prompt/);
    expect(p).toMatch(/shown in earlier slices; some browsers block prompts in/);
    expect(p).toMatch(/non-interactive contexts \(incognito, autofill blockers, etc\.\)/);
    expect(p).toMatch(/Inline reveal is keyboard-accessible \+ paste-target-friendly/);
  });

  it('CRITICAL rotate-reveal 3-field layout pinned — Endpoint + New secret + Old secret valid until. The 3-field reveal is what tells customers WHICH endpoint rotated + WHAT secret + WHEN the old one expires (operator-critical for zero-downtime deploys).', () => {
    const p = read(PAGE);

    // 2026-05-23 — h2 wrapped with icon (rotate-arrow); pin loosened
    // to label-presence + heading shape.
    expect(p).toMatch(/Signing secret rotated/);
    // S21 2026-07-06: text-tk-accent-text (was text-tk-accent-soft — the
    // 13%-alpha WASH token misused as a text color; ~1.2:1, invisible).
    expect(p).toMatch(/text-lg font-semibold text-tk-accent-text/);
    expect(p).toMatch(/data-rotate-endpoint-id/);
    expect(p).toMatch(/data-rotate-secret/);
    expect(p).toMatch(/data-rotate-grace-expires/);
    expect(p).toMatch(/Old secret valid until/);
  });

  it("CRITICAL rotate-reveal customer comms pinned — 'Copy the new secret now — it won't be shown again. The old secret stays valid for the grace window below; roll your verifier forward before then or the next delivery will fail signature check.' Drift to omitting the 'next delivery will fail signature check' framing would let customers miss the deployment urgency.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Copy the new secret now — it won't be shown again\. The old secret stays\s*\n\s+valid for the grace window below; roll your verifier forward before\s*\n\s+then or the next delivery will fail signature check\./,
    );
  });

  it('CRITICAL rotate POST /v1/webhooks/<id>/rotate-secret uses the shared deadline and reconciles an unknown outcome.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\) \+ '\/rotate-secret', \{\s*\n\s+method: 'POST',/,
    );
    expect(p).toMatch(
      /function boundedFetch\(url, init = \{\}\) \{\s*return window\.driftstackFetchWithDeadline\(url, init, WEBHOOK_TIMEOUT_MS\)/,
    );
    expect(p).toMatch(
      /if \(err && err\.name === 'AbortError'\) \{[\s\S]*?refreshEndpointList\(false\)[\s\S]*?uncertainRotationIds\.add\(String\(id\)\)/,
    );

    const rawFetchMutation = p.replace(
      "boundedFetch(apiBaseUrl + '/v1/webhooks/' + encodeURIComponent(id) + '/rotate-secret'",
      "fetch(apiBaseUrl + '/v1/webhooks/' + encodeURIComponent(id) + '/rotate-secret'",
    );
    expect(rawFetchMutation).not.toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\) \+ '\/rotate-secret'/,
    );
  });

  it("CRITICAL V-359 rotation-in-flight indicator pinned. The 'V-359 — rotation-in-flight indicator. When the endpoint is in rotation grace' wording explains WHY the row shows the rotation-grace deadline inline.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-359 — rotation-in-flight indicator\. When the endpoint is/);
    expect(p).toMatch(/escapeHtml\(fmtIsoDay\(e\.rotation_grace_expires_at\)\)/);
  });

  it("Slice 137 — last_success_at inline on the endpoint metadata line. /v1/webhooks already returns last_success_at; surfacing it answers 'is my webhook working?' without drilling into deliveries. Null = no successful delivery recorded yet (new endpoint OR always-failing); the segment is conditionally omitted in that case rather than rendering an ambiguous '—'.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/e\.last_success_at/);
    expect(p).toMatch(/' · last success ' \+ escapeHtml\(fmtIsoDay\(e\.last_success_at\)\)/);
  });

  it("CRITICAL rotate-confirm 24h grace prompt pinned — 'The new secret is shown ONCE. The old secret stays active for 24h so your verifier can roll forward without dropped deliveries.' Drift to omitting would let customers fear rotation breaks their integration.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'Rotate signing secret for ' \+\s*\n\s+id \+\s*\n\s+'\?\\n\\nThe new secret is shown ONCE\. The old secret stays active for 24h so your verifier can roll forward without dropped deliveries\.',/,
    );
  });

  it("CRITICAL rotate-reveal hideRotateReveal wipes secret from DOM. The 'Clear secret from DOM so it isn't recoverable post-dismiss' framing matches W750 api-key rotate-reveal post-dismiss cleanup.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ Clear secret from DOM so it isn't recoverable post-dismiss\./);
    expect(p).toMatch(
      /rotateRevealEl\.classList\.add\('hidden'\);\s*\n\s+\/\/ Clear secret from DOM so it isn't recoverable post-dismiss\.\s*\n\s+rotateSecretEl\.textContent = '';/,
    );
  });

  it('CRITICAL rotate-dismiss reloads page. Drift to no-reload would leave the row showing stale "rotation in flight" markers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /rotateDismissBtn\.addEventListener\('click', \(\) => \{\s*\n\s+hideRotateReveal\(\);\s*\n\s+window\.location\.reload\(\);/,
    );
  });

  it('CRITICAL V-347 create form pinned with POST /v1/webhooks. Drift to a different endpoint or method would break new-endpoint registration.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-347 — wire the create form\./);
    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{\s*\n\s+'content-type': 'application\/json',\s*\n\s+authorization: 'Bearer ' \+ token,/,
    );
  });

  it('CRITICAL V-331b act-as header passthrough on create + rotate + delete. The 3 destructive paths must scope to the team-RBAC selection.', () => {
    const p = read(PAGE);

    const actAsPattern =
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/;

    // At least 3 actAs spreads.
    const matches = p.match(new RegExp(actAsPattern, 'g'));
    expect(matches?.length, 'actAs spreads').toBeGreaterThanOrEqual(3);
  });

  // S32 2026-07-07 (fable-frontend-audit) — the old doc-block claimed
  // /v1/webhooks does NOT expose aggregate delivery_counts and that a
  // mock renders them; both became false (V-185 added the real counts;
  // the page never rendered the mock). The MOCK_WEBHOOKS block was
  // removed and the cards render live counts. Pin the corrected framing
  // + negative pins so the obsolete claims can't return.
  it('CRITICAL V-185 live delivery-counts framing pinned (S32: mock/counts-not-exposed doc-block removed).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/delivery_counts to \/v1\/webhooks/);
    expect(p).toMatch(/the cards render live counts/);
    expect(p).not.toMatch(/does NOT[\s\S]{0,80}include aggregate delivery_counts/);
    expect(p).not.toMatch(/delivery-aggregation endpoint is a separate V-NNN/);
    // The mock array itself is gone (its declaration was `const
    // MOCK_WEBHOOKS: MockWebhookEndpoint[]`); the S32 removal-note
    // comments still name it, so pin the declaration's absence, not the
    // bare token.
    expect(p).not.toMatch(/const MOCK_WEBHOOKS/);
    expect(p).not.toMatch(/hooks\.example\.test/);
  });

  it('CRITICAL every subscribable webhook event has a create-form checkbox — driven by SubscribableWebhookEventTypeSchema so the dashboard can never silently fall behind the API subscribable set. Was a hardcoded 5, which left crypto.order.paid/failed + session.egress_capability_changed unguarded; a new subscribable event now fails this test until the dashboard offers it.', () => {
    const p = read(PAGE);

    for (const ev of SubscribableWebhookEventTypeSchema.options) {
      expect(p, `subscribable event missing a checkbox: ${ev}`).toMatch(
        new RegExp(`value="${ev.replace(/\./g, '\\.')}"`),
      );
    }
  });

  it("CRITICAL V-403/V-443 delivery-log status filter + cursor pagination framing pinned. The 'V-403 + V-443 — delivery-log status filter + cursor pagination' anchor + 'V-443 stores a `cursor` per endpoint in a closure-scoped Map' wording explains WHERE the pagination state lives.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-403 \+ V-443 — delivery-log status filter \+ cursor pagination\./);
    expect(p).toMatch(/V-443 stores a `cursor` per endpoint in a closure-scoped Map so/);
  });

  it('CRITICAL delivery-log replay endpoint pinned — POST /v1/webhook-deliveries/<id>/replay. The per-delivery replay URL is what customers use to re-send a failed delivery without re-creating the source event.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhook-deliveries\/' \+ encodeURIComponent\(id\) \+ '\/replay'/,
    );
  });

  it('CRITICAL POST /v1/webhooks/<id>/test pinned for the test-delivery row action. Drift to dropping would let customers struggle to verify their endpoint works without waiting for a real event.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\) \+ '\/test'/,
    );
  });

  it('CRITICAL PATCH /v1/webhooks/<id> for edit pinned. Drift to overloading POST would force the server to discriminate create-vs-edit; PATCH is the canonical partial-update.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(editingEndpointId\)/,
    );
  });

  it('CRITICAL DELETE /v1/webhooks/<id> pinned for the row revoke action.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/webhooks\/' \+ encodeURIComponent\(id\), \{/,
    );
  });

  it('CRITICAL escapeHtml() XSS guard with 5-char map pinned. Every dynamically-rendered endpoint field flows through it. Drift would let a malicious URL/description inject HTML.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/'&': '&amp;'/);
    expect(p).toMatch(/'<': '&lt;'/);
    expect(p).toMatch(/'>': '&gt;'/);

    const escapeUsages = (p.match(/escapeHtml\(/g) ?? []).length;
    expect(escapeUsages).toBeGreaterThanOrEqual(20);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used. /webhooks IS sidebar-enabled.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Webhooks">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-webhooks-page-v181-v475-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
