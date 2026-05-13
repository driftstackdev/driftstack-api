// W558.A — drift guard for /docs/architecture/api-versioning.md.
// V-220 HTTP API versioning policy. Drift here either weakens the
// /v1-only-major-active posture, drops the additive-vs-breaking
// taxonomy, or loosens the 90-day deprecation cycle commitment.
//
//   • V-220. One major active at a time. /v1/* today.
//   • Additive vs breaking taxonomy with new-enum-value caveat.
//   • Deprecation cycle: Deprecation+Sunset headers (RFC 8594) +
//     OpenAPI deprecated:true + customer email + 90-day minimum.
//   • Per-resource versioning notes (sessions/api-keys/webhooks/
//     billing/admin/account).
//   • What-we-don't-do: header-versioning + per-account date-pinning
//     + continuous breaking changes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/api-versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W558.A /docs/architecture/api-versioning.md content parity', () => {
  const body = read(LIB);

  it("Header + V-220 + TL;DR framing pinned: '# API versioning strategy' + 'V-220 — versioning policy for the HTTP API surface (`/v1/*`,' + 'eventually `/v2/*`). Distinct from the SDK versioning policy at' + '`docs/architecture/sdk-versioning.md` (V-177)' + 'One major version active at a time. `/v1/*` today.' + 'Additive changes are free — new endpoints, new optional request' + 'Breaking changes go through a deprecation cycle, then a new' + 'major version. `/v2/*` only when justified; not on a calendar.' + 'The OpenAPI spec at `/openapi.json` is the contract. Generated' + 'from Zod schemas in `packages/api-types/`; there is no second' — pinned so the V-220-HTTP-API-versioning + distinct-from-V-177-SDK + one-major-active + additive-free + /v2-not-on-calendar + Zod-single-source-of-truth commitment survives", () => {
    expect(body).toMatch(/^# API versioning strategy$/m);
    expect(body).toMatch(/V-220 — versioning policy for the HTTP API surface \(`\/v1\/\*`,/);
    expect(body).toMatch(/eventually `\/v2\/\*`\)\. Distinct from the SDK versioning policy at/);
    expect(body).toMatch(/`docs\/architecture\/sdk-versioning\.md` \(V-177\)/);
    expect(body).toMatch(/- One major version active at a time\. `\/v1\/\*` today\./);
    expect(body).toMatch(/- Additive changes are free — new endpoints, new optional request/);
    expect(body).toMatch(/- Breaking changes go through a deprecation cycle, then a new/);
    expect(body).toMatch(/major version\. `\/v2\/\*` only when justified; not on a calendar\./);
    expect(body).toMatch(/- The OpenAPI spec at `\/openapi\.json` is the contract\. Generated/);
    expect(body).toMatch(/from Zod schemas in `packages\/api-types\/`; there is no second/);
  });

  it("Additive-vs-breaking taxonomy + new-enum-value caveat framing pinned: '| New endpoint                                              | Additive' + 'New enum value (sent BY server, e.g. webhook event types) | **Breaking for closed-enum consumers**' + 'New enum value (accepted FROM client, e.g. tier IDs)      | Additive (server is permissive)' + 'Renaming an existing field                                | Breaking' + 'Changing a field's type (e.g. number → string)' + 'Tightening a validation constraint                        | Breaking' + 'Changing default behaviour of an existing endpoint        | Breaking' + 'Changing rate-limit caps                                  | Operational; not contract' + 'when the **server** sends a closed enum value the **client** doesn't know about' + 'bump major version, OR ship the new value behind a feature flag, OR add a transitional period' — pinned so the 13-row-change-taxonomy + new-enum-server-vs-client-asymmetry + 3-mitigation-options commitment survives", () => {
    expect(body).toMatch(/\| New endpoint\s+\| Additive/);
    expect(body).toMatch(
      /\| New enum value \(sent BY server, e\.g\. webhook event types\) \| \*\*Breaking for closed-enum consumers\*\*/,
    );
    expect(body).toMatch(
      /\| New enum value \(accepted FROM client, e\.g\. tier IDs\)\s+\| Additive \(server is permissive\)/,
    );
    expect(body).toMatch(/\| Renaming an existing field\s+\| Breaking/);
    expect(body).toMatch(/\| Changing a field's type \(e\.g\. number → string\)\s+\| Breaking/);
    expect(body).toMatch(/\| Tightening a validation constraint\s+\| Breaking/);
    expect(body).toMatch(/\| Changing default behaviour of an existing endpoint\s+\| Breaking/);
    expect(body).toMatch(/\| Changing rate-limit caps\s+\| Operational; not contract/);
    expect(body).toMatch(/when the \*\*server\*\*/);
    expect(body).toMatch(/sends a closed enum value the \*\*client\*\* doesn't know about/);
    expect(body).toMatch(/bump major version, OR ship the new value/);
    expect(body).toMatch(/behind a feature flag, OR add a transitional period/);
  });

  it("Deprecation cycle + RFC-8594 + 90-day-minimum framing pinned: '## Deprecation cycle for breaking changes' + '**Announce the deprecation** in a `Deprecation` HTTP response' + 'header on every affected endpoint, with a `Sunset` header' + 'pointing at the planned removal date (RFC 8594).' + '**Document the migration path** in the OpenAPI spec via' + '`deprecated: true` on the affected operation / field' + '**Email customers** using the deprecated surface.' + '**Minimum 90 days** between announcement and removal.' + 'Longer for high-impact changes (e.g. session lifecycle shape).' + '**Remove the surface** in the next major version OR' — pinned so the 5-step-deprecation-cycle + Deprecation+Sunset-headers + RFC-8594 + 90-day-min + session-lifecycle-longer + remove-in-next-major commitment survives", () => {
    expect(body).toMatch(/## Deprecation cycle for breaking changes/);
    expect(body).toMatch(/1\. \*\*Announce the deprecation\*\* in a `Deprecation` HTTP response/);
    expect(body).toMatch(/header on every affected endpoint, with a `Sunset` header/);
    expect(body).toMatch(/pointing at the planned removal date \(RFC 8594\)\./);
    expect(body).toMatch(/2\. \*\*Document the migration path\*\* in the OpenAPI spec via/);
    expect(body).toMatch(/`deprecated: true` on the affected operation \/ field/);
    expect(body).toMatch(/3\. \*\*Email customers\*\* using the deprecated surface\./);
    expect(body).toMatch(/4\. \*\*Minimum 90 days\*\* between announcement and removal\. Longer/);
    expect(body).toMatch(/for high-impact changes \(e\.g\. session lifecycle shape\)\./);
    expect(body).toMatch(/5\. \*\*Remove the surface\*\* in the next major version OR/);
  });

  it("New-major-justified + operating-two-majors framing pinned: '## When a new major version is justified' + '`/v2/*` ships when:' + 'A breaking change can't be avoided (e.g. session lifecycle' + 'redesign that needs different state-machine semantics).' + 'Multiple breaking changes batch sensibly' + 'An entirely new architectural shape lands' + 'It does NOT ship when:' + 'Pre-1.0-style restlessness wants to \"clean things up.\"' + '## Operating two majors simultaneously' + '`/v1/*` continues to work for the announced sunset window' + '(typically 12+ months).' + 'Customers can pin a version via the URL prefix; no header-based' + 'versioning today.' — pinned so the /v2-justified-3-criteria + 2-non-criteria + 12-month-sunset + URL-prefix-pin-no-header commitment survives", () => {
    expect(body).toMatch(/## When a new major version is justified/);
    expect(body).toMatch(/`\/v2\/\*` ships when:/);
    expect(body).toMatch(/- A breaking change can't be avoided \(e\.g\. session lifecycle/);
    expect(body).toMatch(/redesign that needs different state-machine semantics\)\./);
    expect(body).toMatch(/- Multiple breaking changes batch sensibly/);
    expect(body).toMatch(/- An entirely new architectural shape lands/);
    expect(body).toMatch(/It does NOT ship when:/);
    expect(body).toMatch(/- Pre-1\.0-style restlessness wants to "clean things up\."/);
    expect(body).toMatch(/## Operating two majors simultaneously/);
    expect(body).toMatch(/- `\/v1\/\*` continues to work for the announced sunset window/);
    expect(body).toMatch(/\(typically 12\+ months\)\./);
    expect(body).toMatch(/- Customers can pin a version via the URL prefix; no header-based/);
    expect(body).toMatch(/versioning today\./);
  });

  it("Per-resource versioning notes 6-resource framing pinned: '## Per-resource versioning notes' + '`/v1/sessions/*`** — session lifecycle is the most-likely' + 'candidate for a future `/v2/*` cut.' + '`purpose` + `archetype` fields (V-169)' + '`/v1/api-keys/*`** — scope enum is the breaking-change risk' + '(V-174 was the most recent expansion' + '`/v1/webhooks/*`** — `WebhookEventType` enum is closed.' + '`docs/api/webhook-events.md` per V-203' + '`docs/architecture/webhook-system-design.md`' + '`/v1/billing/*`** — Stripe-driven; subscription/trial-pack' + '`/v1/admin/*`** — internal-staff surface; staff = founder pre-' + '`/v1/account/*`** — customer self-serve account data' + '(audit-log, email-preferences, rate-limits per V-216 / V-204 /' + 'V-219)' — pinned so the 6-resource-versioning-table (V-169-sessions + V-174-api-keys + V-203-webhooks + Stripe-billing + admin-staff + V-216/V-204/V-219-account) commitment survives", () => {
    expect(body).toMatch(/## Per-resource versioning notes/);
    expect(body).toMatch(/`\/v1\/sessions\/\*`\*\* — session lifecycle is the most-likely/);
    expect(body).toMatch(/candidate for a future `\/v2\/\*` cut\./);
    expect(body).toMatch(/`purpose` \+ `archetype` fields \(V-169\)/);
    expect(body).toMatch(/`\/v1\/api-keys\/\*`\*\* — scope enum is the breaking-change risk/);
    expect(body).toMatch(/\(V-174 was the most recent expansion/);
    expect(body).toMatch(/`\/v1\/webhooks\/\*`\*\* — `WebhookEventType` enum is closed\./);
    expect(body).toMatch(/`docs\/api\/webhook-events\.md`/);
    expect(body).toMatch(/per V-203, and the system-design rationale at/);
    expect(body).toMatch(/`docs\/architecture\/webhook-system-design\.md`/);
    expect(body).toMatch(/`\/v1\/billing\/\*`\*\* — Stripe-driven; subscription\/trial-pack/);
    expect(body).toMatch(/`\/v1\/admin\/\*`\*\* — internal-staff surface; staff = founder pre-/);
    expect(body).toMatch(/`\/v1\/account\/\*`\*\* — customer self-serve account data/);
    expect(body).toMatch(/\(audit-log, email-preferences, rate-limits per V-216 \/ V-204 \//);
    expect(body).toMatch(/V-219\)/);
  });

  it("What-we-don't-do + Related framing pinned: '## What customers should do' + 'Pin to a specific major in their integration.' + 'Subscribe explicitly to webhook events they handle; ignore +' + 'continue on unknown event types (defensive parsing).' + 'Watch the `Deprecation` + `Sunset` response headers' + '## What we don't do' + '**Header-based versioning** (`API-Version: 2024-05-01`) —' + 'considered but rejected. URL-prefix is more discoverable' + '**Date-based versioning per-account** (Stripe's \"API version' + 'pinning\")' + '**Continuous breaking changes** — pre-1.0 SDKs ship them' + '(V-201 broke AccountTier; documented + intended).' + '## Related' + 'SDK versioning policy: `docs/architecture/sdk-versioning.md` (V-177).' + 'OpenAPI spec generation: `apps/server/src/lib/openapi.ts`.' + 'Locked tech-stack: `AGENTS.md` (Zod single-source-of-truth).' + 'Webhook event catalog: `docs/api/webhook-events.md` (V-203).' — pinned so the 3-customer-action + 3-we-don't-do (header + date-pinning + continuous-breaking) + V-201-AccountTier + 4-Related-link commitment survives", () => {
    expect(body).toMatch(/## What customers should do/);
    expect(body).toMatch(/- Pin to a specific major in their integration\./);
    expect(body).toMatch(/- Subscribe explicitly to webhook events they handle; ignore \+/);
    expect(body).toMatch(/continue on unknown event types \(defensive parsing\)\./);
    expect(body).toMatch(/- Watch the `Deprecation` \+ `Sunset` response headers/);
    expect(body).toMatch(/## What we don't do/);
    expect(body).toMatch(/- \*\*Header-based versioning\*\* \(`API-Version: 2024-05-01`\) —/);
    expect(body).toMatch(/considered but rejected\. URL-prefix is more discoverable/);
    expect(body).toMatch(/- \*\*Date-based versioning per-account\*\* \(Stripe's "API version/);
    expect(body).toMatch(/pinning"\)/);
    expect(body).toMatch(/- \*\*Continuous breaking changes\*\* — pre-1\.0 SDKs ship them/);
    expect(body).toMatch(/\(V-201 broke AccountTier; documented \+ intended\)\./);
    expect(body).toMatch(/## Related/);
    expect(body).toMatch(
      /- SDK versioning policy: `docs\/architecture\/sdk-versioning\.md` \(V-177\)\./,
    );
    expect(body).toMatch(/- OpenAPI spec generation: `apps\/server\/src\/lib\/openapi\.ts`\./);
    expect(body).toMatch(/- Locked tech-stack: `AGENTS\.md` \(Zod single-source-of-truth\)\./);
    expect(body).toMatch(/- Webhook event catalog: `docs\/api\/webhook-events\.md` \(V-203\)\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
