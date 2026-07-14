// W604 — drift guard for apps/docs/src/pages/reference + webhooks.
// 6 modules in one suite: errors + rate-limits + scopes + endpoints + events + replay.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ERR = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');
const RL = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/rate-limits.md');
const SC = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/scopes.md');
const WE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');
const EV = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');
const RP = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W604 apps/docs reference + webhooks pages content parity', () => {
  it('reference/errors.md: RFC 9457 problem-details + every problem-type URI + 3-language matrix + retryable column (rate-limited yes / internal yes / TransportError yes; everything else no). Re-enabled by slice 305 — the V-507 anchor was R4-scrubbed (commit b46b8d4124b "V-NNN session-log scrub from customer-facing surfaces"), which left an orphaned "reference." lead-in; that residue has since been removed so the intro reads as the intended sentence', () => {
    const body = read(ERR);
    expect(body).toMatch(/^title: Error reference$/m);
    expect(body).toMatch(/^Every error response from the Driftstack API is$/m);
    expect(body).toMatch(/RFC 9457 Problem Details/);
    expect(body).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(body).toMatch(/"retry_after_seconds": 12/);
    expect(body).toMatch(
      /`errors\.driftstack\.dev\/rate-limited`\s+\| 429\s+\| `RateLimitError`\s+\| `RateLimitError`\s+\| `RateLimitError`\s+\| \*\*yes\*\*/,
    );
    expect(body).toMatch(
      /`errors\.driftstack\.dev\/internal`\s+\| 5xx\s+\| `InternalError`\s+\| `InternalError`\s+\| `InternalError`\s+\| \*\*yes\*\*/,
    );
    expect(body).toMatch(
      /\(network failure \/ parse error\)\s+\| 0\s+\| `TransportError`\s+\| `TransportError`\s+\| `TransportError`\s+\| \*\*yes\*\*/,
    );
    expect(body).toMatch(/`errors\.driftstack\.dev\/concurrency-limit`\s+\| 429/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/tier-limit`\s+\| 429/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/session-destroyed`\s+\| 410/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/session-timeout`\s+\| 504/);
    expect(body).toMatch(/`errors\.driftstack\.dev\/driver-not-integrated`\s+\| 503/);
    expect(body).toMatch(/^## When to retry$/m);
    expect(existsSync(ERR)).toBe(true);
  });

  it('reference/rate-limits.md: token-bucket anti-abuse-not-pricing-meter (concurrent-only per ADR-004) + 3 bucket keys (global + sessions:create + agent_sessions:message) + 8-tier defaults pinned. Re-enabled by slice 306 — the V-505 anchor was R4-scrubbed, which left an orphaned "reference." lead-in; that residue has since been removed so the intro reads as the intended sentence. v2-#8 sub-slice 8.20 added the agent_sessions:message bucket so LLM-driven message loops can\'t drain global.', () => {
    const body = read(RL);
    expect(body).toMatch(/^title: Rate limits$/m);
    expect(body).toMatch(/^Driftstack enforces per-tier token-bucket rate$/m);
    expect(body).toMatch(/Driftstack enforces per-tier token-bucket rate/);
    expect(body).toMatch(/intentional anti-abuse caps \(runaway scripts, accidental DoS\),/);
    expect(body).toMatch(/not the pricing meter\. Pricing is concurrent-only per ADR-004\./);
    expect(body).toMatch(/^## Four bucket keys$/m);
    // S36 2026-07-07 (fable-truth-audit): global is only drained by calls
    // WITHOUT a dedicated bucket — each call consumes exactly one bucket.
    expect(body).toMatch(
      /- \*\*`global`\*\* — every authenticated `\/v1\/\*` call that doesn't\s*\n?\s*have a dedicated bucket below\./,
    );
    expect(body).toMatch(/- \*\*`sessions:create`\*\* — `POST \/v1\/sessions` only\./);
    expect(body).toMatch(
      /- \*\*`agent_sessions:message`\*\* —\s*\n?\s*`POST \/v1\/agent-sessions\/:id\/message` only/,
    );
    expect(body).toMatch(
      /Each call drains exactly one bucket: a `POST \/v1\/sessions`\s*\n?consumes from `sessions:create` only \(never `global`\)/,
    );
    expect(body).toMatch(/\| `free`\s+\| 60\s+\| 1\s+\|/);
    expect(body).toMatch(/\| `api_starter`\s+\| 240\s+\| 4\s+\|/);
    expect(body).toMatch(/\| `api_builder`\s+\| 1,800\s+\| 30\s+\|/);
    expect(body).toMatch(/\| `api_scale`\s+\| 6,000\s+\| 100\s+\|/);
    expect(body).toMatch(/\| `enterprise`\s+\| 60,000\s+\| 1,000\s+\|/);
    expect(existsSync(RL)).toBe(true);
  });

  it('reference/scopes.md: 3 categories (Broad read/write/admin + Account-control account_owner/driftstack_internal_admin + Granular verb:resource) + L-001 gui_control special scope pinned. Re-enabled by slice 307 — V-505 (header anchor), V-481 (Granular subtitle), and V-174 (admin-legacy table cell) were all R4-scrubbed; the table cell now says "Pre-alias" instead of "Pre-V-174 alias"', () => {
    const body = read(SC);
    expect(body).toMatch(/^title: API key scopes$/m);
    expect(body).toMatch(/^Every Driftstack API key carries a set of$/m);
    expect(body).toMatch(/Every Driftstack API key carries a set of/);
    expect(body).toMatch(/scopes\./);
    expect(body).toMatch(/^## Scope categories$/m);
    expect(body).toMatch(/1\. \*\*Broad scopes\*\* — `read`, `write`, `admin`\./);
    expect(body).toMatch(/2\. \*\*Account-control scopes\*\* — `account_owner`,/);
    expect(body).toMatch(/`driftstack_internal_admin`\./);
    expect(body).toMatch(/3\. \*\*Granular scopes \*\* — `verb:resource` syntax/);
    expect(body).toMatch(/\| `admin`\s+\| broad \(legacy\)\s+\| Deprecated customer alias\./);
    expect(body).toMatch(
      /Satisfies `account_owner` and customer `admin:\*` scopes, but never the staff-only `driftstack_internal_admin` scope\./,
    );
    expect(body).toMatch(/\| `gui_control`\s+\| special\s+\| Manual-control plane/);
    expect(body).toMatch(/Self-hosted GUI workflow only \(locked-decision L-001\)\./);
    expect(existsSync(SC)).toBe(true);
  });

  it('webhooks/endpoints.md: customer-controlled HTTPS URL + signing-secret-shown-ONCE + 24h rotation grace + single-header compound dual-v1= sign + consecutive-failures auto-disable + test.ping rejected from subscribe list pinned. Re-enabled by slice 322 post the R4 V-NNN scrub — the (V-359) anchor between "after a secret rotation" and "When non-null, Driftstack is dual-signing" was removed', () => {
    const body = read(WE);
    expect(body).toMatch(/^title: Webhook endpoints$/m);
    expect(body).toMatch(/customer-controlled HTTPS URL that/);
    expect(body).toMatch(/Driftstack POSTs event payloads to\./);
    expect(body).toMatch(/Safe to log \+ display; the full secret is shown ONCE at create/);
    expect(body).toMatch(/`prev_secret_prefix` \+ `rotation_grace_expires_at` are null/);
    expect(body).toMatch(/except during the 24-hour grace period after a secret rotation/);
    expect(body).toMatch(/When non-null, Driftstack is dual-signing every outbound/);
    expect(body).toMatch(/the single `x-driftstack-signature` header carries/);
    expect(body).toMatch(/`consecutive_failures` increments on each failed delivery \+ zeros/);
    expect(body).toMatch(/endpoint auto-disables \(`disabled_at` set\)/);
    expect(body).toMatch(/Only subscribable event types/);
    expect(body).toMatch(/count here; `test\.ping` is delivery-side-only and is rejected if/);
    expect(existsSync(WE)).toBe(true);
  });

  it('webhooks/events.md: current emitted-event catalog, synthetic test event, and common envelope are pinned without speculative event rows', () => {
    const body = read(EV);
    expect(body).toMatch(/^title: Webhook events catalog$/m);
    expect(body).toMatch(/^# Webhook events — catalog \+ payload shapes$/m);
    for (const event of [
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'test.ping',
      'session.egress_capability_changed',
      'crypto.order.paid',
      'crypto.order.failed',
      'session.challenge_detected',
      'session.profile_save_failed',
    ]) {
      expect(body).toContain(`| \`${event}\``);
    }
    expect(body).not.toMatch(/\[DECLARED\]|\[PLANNED\]|quota\.|trial_pack\./);
    expect(body).toMatch(/^## Common envelope$/m);
    expect(body).toMatch(/"id": "<uuid>"/);
    expect(body).toMatch(/"type": "<event-type>"/);
    // The real delivered body (services/webhooks.ts) is { id, type,
    // created_at, data } — NO account_id, NO emitted_at.
    expect(body).toMatch(/"created_at": "2026-05-05T12:34:56\.789Z"/);
    expect(body).not.toMatch(/"account_id":/);
    expect(existsSync(EV)).toBe(true);
  });

  it('webhooks/replay.md: 5-retry-exp-backoff-then-DLQ + POST /v1/webhook-deliveries/:id/replay + reset-to-pending + ~30s next-cycle + account-scoped + empty body + 200 response shape pinned', () => {
    const body = read(RP);
    expect(body).toMatch(/^title: Replaying webhook deliveries$/m);
    expect(body).toMatch(/^# Replaying webhook deliveries$/m);
    expect(body).toMatch(/Driftstack retries failed webhook deliveries 5 times with exponential/);
    expect(body).toMatch(/backoff before parking them in the DLQ\./);
    // S27 (2026-07-07) — the h2 was the literal "Endpoint" (rendered as a
    // meaningless "POST Endpoint" sub-node in the docs tree); renamed.
    expect(body).toMatch(/^## Replay a delivery$/m);
    expect(body).toMatch(/`POST \/v1\/webhook-deliveries\/:deliveryId\/replay`/);
    expect(body).toMatch(/Resets the delivery to `pending` so the worker re-fires it on the next/);
    expect(body).toMatch(/cycle \(within ~30 seconds\)\./);
    expect(body).toMatch(/Account-scoped: the delivery must belong/);
    expect(body).toMatch(/Request body: `\{\}` \(empty\)\./);
    expect(body).toMatch(/"status": "pending",/);
    expect(body).toMatch(/"attempts": 0,/);
    expect(body).toMatch(/~2 hours later the deliveries land in DLQ\s*\n?\s*\(`status: "dlq"`\)\./);
    expect(body).toMatch(/`GET \/v1\/webhooks\/:webhookId\/deliveries\?status=dlq`/);
    expect(existsSync(RP)).toBe(true);
  });
});
