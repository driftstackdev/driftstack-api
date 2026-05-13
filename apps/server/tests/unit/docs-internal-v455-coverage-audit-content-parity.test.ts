// W578.A — drift guard for /docs/internal/v455-coverage-audit.md.
// V-455 comprehensive OpenAPI + SDK coverage audit (Rule L systematic-
// discovery pattern, V-441/V-445/V-452 lineage). Drift here either
// weakens the 4-axis taxonomy (OpenAPI / TS / Py / Go), shifts the
// per-resource ✅/❌/🚫/〰 verdict for any route, or drops the V-456→
// V-465 per-gap-closure-slice catalogue.
//
//   • Generated 2026-05-09; re-run commands pinned.
//   • Customer-facing surfaces: 12 sub-sections, every route classified.
//   • Sessions /v1/sessions/:id/gui-input — 🚫 by L-001 gui-control plane.
//   • Status /v1/status/* — SDK exposure intentionally 🚫 (V-459 closed).
//   • Aggregate gap counts: 0 customer-facing OpenAPI gaps + 0 admin
//     OpenAPI gaps + 0 actionable SDK gaps + 7 intentional 🚫.
//   • Per-gap closure slices V-456 through V-465 catalogued.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v455-coverage-audit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W578.A /docs/internal/v455-coverage-audit.md content parity', () => {
  const body = read(LIB);

  it('Header + Rule-L lineage + 4-axis taxonomy + symbols + 2026-05-09 generation + re-run-commands framing pinned', () => {
    expect(body).toMatch(/^# V-455 — Comprehensive OpenAPI \+ SDK coverage audit$/m);
    expect(body).toMatch(/Per Rule L systematic discovery \(V-441\/V-445\/V-452 pattern\)\./);
    expect(body).toMatch(/Enumerates every server route under `apps\/server\/src\/routes\/` and/);
    expect(body).toMatch(/classifies its coverage across:/);
    expect(body).toMatch(/1\. \*\*OpenAPI spec\*\* \(`apps\/server\/src\/lib\/openapi\.ts`\)\./);
    expect(body).toMatch(
      /2\. \*\*TS SDK\*\* \(`packages\/sdk-typescript\/src\/resources\/\*\.ts`\)\./,
    );
    expect(body).toMatch(
      /3\. \*\*Python SDK\*\* \(`packages\/sdk-python\/src\/driftstack\/resources\/\*\.py`\)\./,
    );
    expect(body).toMatch(/4\. \*\*Go SDK\*\* \(`packages\/sdk-go\/\*\.go`\)\./);
    expect(body).toMatch(/Symbols:/);
    expect(body).toMatch(/- ✅ — covered\./);
    expect(body).toMatch(/- ❌ — missing\./);
    expect(body).toMatch(/- 🚫 — intentionally not exposed \(admin \/ staff \/ internal\)\./);
    expect(body).toMatch(/- 〰 — partial \(e\.g\. only some sub-paths covered\)\./);
    expect(body).toMatch(/Generated 2026-05-09\. Re-run by:/);
    expect(body).toMatch(
      /grep -rhEo "\['\\\\\\"\]\/v\[0-9\]\[\^'\\\\\\"\]\+\['\\\\\\"\]" apps\/server\/src\/routes\/ \| sort -u/,
    );
    expect(body).toMatch(
      /grep -oE "'\/v\[0-9\]\[\^'\]\+'" apps\/server\/src\/lib\/openapi\.ts \| sort -u/,
    );
    expect(body).toMatch(/grep -roE "'\/v\[0-9\]\[\^'\]\+'" packages\/sdk-typescript\/src/);
    expect(body).toMatch(/grep -roE "\\"\/v\[0-9\]\[\^\\"\]\+\\"" packages\/sdk-python\/src/);
    expect(body).toMatch(/grep -roE "\\"\/v\[0-9\]\[\^\\"\]\+\\"" packages\/sdk-go/);
  });

  it('Customer-facing surfaces Auth + Account + Sessions tables pinned: V-401/V-402/V-445/V-460 auth + V-385/V-428/V-434/V-449/V-450/V-462 account + V-461 gui-input-🚫-L-001', () => {
    expect(body).toMatch(/## Customer-facing surfaces/);
    expect(body).toMatch(/### Auth \(`\/v1\/auth\/\*`\)/);
    expect(body).toMatch(
      /\| POST \/v1\/auth\/signup\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-401\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/auth\/login\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-401, V-423 union return \|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/auth\/mfa\/challenge\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-401, V-445 SDK methods\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/auth\/cli-authorize\/initiate \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-460\s+\|/,
    );
    expect(body).toMatch(/### Account self-service \(`\/v1\/account\/\*`\)/);
    expect(body).toMatch(
      /\| GET \/v1\/account\/me\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-385\/V-428\/V-434\s+\|/,
    );
    expect(body).toMatch(
      /\| GET \/v1\/account\/audit-log\/export\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-462 \(JSON branch\)\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/account\/mfa\/disable\s+\| ✅\s+\| 〰\s+\| 〰\s+\| 〰\s+\| DELETE alias; SDKs use DELETE \|/,
    );
    expect(body).toMatch(/### Sessions \(`\/v1\/sessions`\)/);
    expect(body).toMatch(/\| POST \/v1\/sessions\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅/);
    expect(body).toMatch(
      /\| POST \/v1\/sessions\/:id\/gui-input \| 🚫\s+\| 🚫\s+\| 🚫\s+\| 🚫\s+\| L-001 gui-control plane/,
    );
    expect(body).toMatch(
      /coordinate primitives bypass behavioural simulation\. Server gates behind `gui_control` scope \(only enterprise self-hosted GUI keys carry it; customer keys never do\)\. Intentionally NOT in customer-facing OpenAPI or SDKs \(V-461 reclassification\)/,
    );
  });

  it('Profiles OpenAPI-GAP base-CRUD + API-keys + Webhooks + Billing + Team + Usage tables pinned: 5-OpenAPI-gap profiles + V-296 rotate + V-457/V-307/V-359/V-416-418/V-356/V-463/V-464 webhooks + V-420 billing', () => {
    expect(body).toMatch(/### Profiles \(`\/v1\/profiles`\)/);
    expect(body).toMatch(
      /\| POST \/v1\/profiles\s+\| ❌\s+\| ✅\s+\| ✅\s+\| ✅\s+\| \*\*OpenAPI GAP\*\* — base create unregistered \|/,
    );
    expect(body).toMatch(
      /\| GET \/v1\/profiles\s+\| ❌\s+\| ✅\s+\| ✅\s+\| ✅\s+\| \*\*OpenAPI GAP\*\* — list\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/profiles\/:id\/clone\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-313\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/profile-snapshots\/:id\/restore \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-312\s+\|/,
    );
    expect(body).toMatch(/### API keys \(`\/v1\/api-keys`\)/);
    expect(body).toMatch(
      /\| POST \/v1\/api-keys\/:id\/rotate \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-296 \|/,
    );
    expect(body).toMatch(/### Webhooks \(`\/v1\/webhooks`\)/);
    expect(body).toMatch(
      /\| PATCH \/v1\/webhooks\/:id\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-457 spec \/ V-464 SDKs\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/webhooks\/:id\/rotate-secret\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-359 \/ V-416-418\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/webhooks\/:id\/test\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-356 spec \/ V-463 SDKs\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/webhook-deliveries\/:deliveryId\/replay \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-307\s+\|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/webhooks\/stripe\s+\| 🚫\s+\| 🚫\s+\| 🚫\s+\| 🚫\s+\| Stripe-hosted webhook receiver \|/,
    );
    expect(body).toMatch(/### Billing \(`\/v1\/billing`\)/);
    expect(body).toMatch(
      /\| POST \/v1\/billing\/checkout-session \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-420 \|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/billing\/trial-pack\s+\| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-420 \|/,
    );
    expect(body).toMatch(/### Team \(`\/v1\/team`\)/);
    expect(body).toMatch(/\| POST \/v1\/team\/invites\/accept \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\|/);
    expect(body).toMatch(/### Usage \(`\/v1\/usage`\)/);
    expect(body).toMatch(/\| GET \/v1\/usage\/series \| ✅\s+\| ✅\s+\| ✅\s+\| ✅\s+\| V-452 \|/);
  });

  it('Legal-GAP + Status-V-459-public + Admin-V-465 + SDK-exposure-decision framing pinned: 3 legal GAPs + V-459 status public + V-465 admin 12-route closure + status-SDK-🚫-by-design rationale', () => {
    expect(body).toMatch(/### Legal \(`\/v1\/legal`\)/);
    expect(body).toMatch(
      /\| GET \/v1\/legal\/documents \| ❌\s+\| ❌\s+\| ❌\s+\| ❌\s+\| \*\*GAP\*\* — version \+ content_hash\s+\|/,
    );
    expect(body).toMatch(
      /\| GET \/v1\/legal\/required\s+\| ❌\s+\| ❌\s+\| ❌\s+\| ❌\s+\| \*\*GAP\*\* — what customer needs to accept \|/,
    );
    expect(body).toMatch(
      /\| POST \/v1\/legal\/accept\s+\| ❌\s+\| ❌\s+\| ❌\s+\| ❌\s+\| \*\*GAP\*\* — accept doc versions\s+\|/,
    );
    expect(body).toMatch(/### Status \(`\/v1\/status`\)/);
    expect(body).toMatch(
      /\| GET \/v1\/status\s+\| ✅ V-459 \| 🚫\s+\| 🚫\s+\| 🚫\s+\| Public status; SDK exposure intentionally omitted \(V-459\)\. \|/,
    );
    expect(body).toMatch(/\| GET \/v1\/status\/stream\s+\| 🚫\s+\| 🚫/);
    expect(body).toMatch(/SSE stream — typed differently/);
    expect(body).toMatch(
      /\*\*SDK exposure decision\*\* — `\/v1\/status\/\*` is a public, no-auth surface/,
    );
    expect(body).toMatch(/consumed by the marketing-site status indicator and external uptime/);
    expect(body).toMatch(
      /monitors\. Customers monitor vendor status from outside their integration/,
    );
    expect(body).toMatch(
      /code \(status pages, third-party probes\); embedding it in `client\.status\.\*`/,
    );
    expect(body).toMatch(/would invite anti-patterns where customer code branches on the vendor/);
    expect(body).toMatch(/status response\. Reclassified 🚫 \(intentional non-exposure\)\./);
    expect(body).toMatch(/## Admin \/ staff surfaces \(intentionally NOT in customer SDKs\)/);
    expect(body).toMatch(
      /These routes power the admin panel; they're 🚫 for customer SDKs by design but should still be in OpenAPI for the admin-internal SDK surface\./,
    );
    expect(body).toMatch(/\| GET \/v1\/admin\/overview\s+\| ✅\s+\|\s+\|/);
    expect(body).toMatch(/\| POST \/v1\/admin\/accounts\/:id\/refund-record\s+\| ✅\s+\| V-465 \|/);
    expect(body).toMatch(/\| POST \/v1\/admin\/incidents\/:id\/updates\s+\| ✅\s+\| V-465 \|/);
    expect(body).toMatch(
      /\| POST \/v1\/admin\/status-subscribers\/:id\/force-unsubscribe \| ✅\s+\| V-465 \|/,
    );
    expect(body).toMatch(/\| POST \/v1\/admin\/webhook-dlq\/:id\/requeue\s+\| ✅\s+\|\s+\|/);
  });

  it('Aggregate gap counts + per-gap closure slices V-456–V-465 framing pinned: 0-customer-OpenAPI-gap + 0-actionable-SDK-gap + 7-intentional-🚫 + V-456-profiles + V-457-webhooks + V-458-legal + V-459-status-shipped + V-460-cli-shipped + V-461-gui-input-🚫-shipped + V-462-audit-export + V-463-test-shipped + V-464-PATCH-shipped + V-465-admin-shipped', () => {
    expect(body).toMatch(/## Aggregate gap counts/);
    expect(body).toMatch(/\| Auth\s+\| 14\s+\| 0 \(V-460 closed\)\s+\| 0 \(V-460 closed\)\s+\|/);
    expect(body).toMatch(/\| Account\s+\| 18\s+\| 0\s+\| 0 \(V-462 closed\)\s+\|/);
    expect(body).toMatch(
      /\| Sessions\s+\| 10\s+\| 0 \(V-461: gui-input 🚫 by L-001\)\s+\| 0 \(V-461: gui-input 🚫\) \|/,
    );
    expect(body).toMatch(/\| Profiles\s+\| 12\s+\| 5 \(base CRUD\)\s+\| 0\s+\|/);
    expect(body).toMatch(
      /\| Webhooks\s+\| 10\s+\| 0 \(V-457 closed\)\s+\| 0 \(V-463\/V-464 closed\)\s+\|/,
    );
    expect(body).toMatch(/\| Legal\s+\| 3\s+\| 3\s+\| 3\s+\|/);
    expect(body).toMatch(
      /\| Status \(public\)\s+\| 7\s+\| 0 \(V-459 closed; 1 SSE intentional\) \| 6 \(intentional\)\s+\|/,
    );
    expect(body).toMatch(/\| Admin\s+\| 27\s+\| 0 \(V-465 closed\)\s+\| 🚫 \(admin-only\)\s+\|/);
    expect(body).toMatch(/\*\*Customer-facing OpenAPI gaps after V-464:\*\* 0\. 🎉/);
    expect(body).toMatch(/\*\*Customer-facing SDK gaps after V-464:\*\* 0 actionable\. 🎉🎉/);
    expect(body).toMatch(/Plus 7 intentional 🚫 \(6 status \+ gui-input\)\./);
    expect(body).toMatch(
      /\*\*Admin OpenAPI gaps after V-465:\*\* 0\. 🎉 \(Spec is now 100% complete across customer \+ admin surfaces\.\)/,
    );
    expect(body).toMatch(/## Per-gap closure slices \(priority order\)/);
    expect(body).toMatch(/Tier 1 \(customer-facing OpenAPI parity — most impactful\):/);
    expect(body).toMatch(
      /- \*\*V-456\*\* — register `\/v1\/profiles` base CRUD in OpenAPI \(5 routes; SDKs already cover\)\./,
    );
    expect(body).toMatch(
      /- \*\*V-457\*\* — register `\/v1\/webhooks` base CRUD \+ deliveries \+ PATCH in OpenAPI \(6 routes\)\./,
    );
    expect(body).toMatch(
      /- \*\*V-458\*\* — register `\/v1\/legal\/\*` \(3 routes\) \+ add SDK methods\./,
    );
    expect(body).toMatch(
      /- \*\*V-459\*\* — register `\/v1\/status\/\*` \(6 routes\) in OpenAPI; SDK exposure intentionally 🚫 \(status is monitoring data — out-of-band by design\)\. ✅ shipped\./,
    );
    expect(body).toMatch(
      /- \*\*V-460\*\* — register `\/v1\/auth\/cli-authorize\/\*` \(3 routes\) \+ add three-SDK methods\. ✅ shipped\./,
    );
    expect(body).toMatch(
      /- \*\*V-461\*\* — `\/v1\/sessions\/:id\/gui-input` reclassified to 🚫 \(L-001 gui-control plane;/,
    );
    expect(body).toMatch(
      /coordinate primitives bypass behavioural simulation; server gates behind `gui_control`/,
    );
    expect(body).toMatch(
      /scope which only enterprise self-hosted GUI keys carry, never customer keys\)\. No OpenAPI/,
    );
    expect(body).toMatch(/registration; no SDK methods\. ✅ shipped \(doc-only\)\./);
    expect(body).toMatch(
      /- \*\*V-462\*\* — register `\/v1\/account\/audit-log\/export` properly \+ add SDK method\./,
    );
    expect(body).toMatch(
      /- \*\*V-463\*\* — `\/v1\/webhooks\/:id\/test` SDK methods \(V-356 send-test wrapper\)\. ✅ shipped\./,
    );
    expect(body).toMatch(
      /- \*\*V-464\*\* — `\/v1\/webhooks\/:id` PATCH SDK method \(update events \/ description\)\. ✅ shipped\./,
    );
    expect(body).toMatch(/Tier 2 \(admin OpenAPI parity\):/);
    expect(body).toMatch(
      /- \*\*V-465\*\* — register 12 missing \/v1\/admin\/\\\* routes in OpenAPI\. ✅ shipped\./,
    );
    expect(body).toMatch(/Each slice ships per V-NNN convention with closure verification:/);
    expect(body).toMatch(/spec test paths fixture extended, three-SDK build\/test green\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
