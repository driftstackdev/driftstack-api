// W552.A — drift guard for /docs/launch/pre-launch-checklist.md.
// Launch-readiness audit + priority queue. Drift here either
// weakens the 10-section roll-up structure (would orphan the
// single-page audit role), drops the 3-status tagging (READY /
// PENDING ENG / PENDING FOUNDER — drives the agent-vs-founder
// queue), or weakens the source-of-truth split (per-runbook detail
// in docs/founder-actions + docs/deployment + docs/operations).
//
//   • Single-page audit + priority queue.
//   • 10 sections: Backend + SDKs + GUI + Customer-dashboard +
//     Marketing-site + Doc-site + Infrastructure + Legal +
//     Customer-support + Observability/operations.
//   • Status tags: READY / PENDING ENG / PENDING FOUNDER.
//   • Last roll-up: 2026-05-07 (V-279) refreshed via V-287 +
//     V-361 (V-353 cycle + V-359 + V-298a + V-313 + V-360).
//   • Cross-repo dep on Agent 1 V-203 Phase 2A + V-372–V-378.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/launch/pre-launch-checklist.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W552.A /docs/launch/pre-launch-checklist.md content parity', () => {
  const body = read(LIB);

  it("Header + 3-status + source-of-truth split framing pinned: '# Driftstack pre-launch checklist' + 'Roll-up of every item between current state and \"first paying customer can sign up, pay, and use the product.\" Each item is tagged with status (READY / PENDING ENG / PENDING FOUNDER), owner, blocking-launch (yes/no), and rough estimate.' + 'This checklist = single-page audit + priority queue.' + 'Per-runbook detail lives in `docs/founder-actions/v*.md` + `docs/deployment/*.md` + `docs/operations/*.md`.' + 'Per-V-NNN history lives in `docs/verification-log.md`.' + '**Last roll-up:** 2026-05-07 (V-279)' — pinned so the first-paying-customer-roll-up + 3-status-tagging + single-page-audit + per-runbook-detail-cross-reference + V-NNN-history + V-279-2026-05-07 commitment survives", () => {
    expect(body).toMatch(/^# Driftstack pre-launch checklist$/m);
    expect(body).toMatch(
      /Roll-up of every item between current state and "first paying customer can sign up, pay, and use the product\."/,
    );
    expect(body).toMatch(
      /Each item is tagged with status \(READY \/ PENDING ENG \/ PENDING FOUNDER\), owner, blocking-launch \(yes\/no\), and rough estimate\./,
    );
    expect(body).toMatch(/- This checklist = single-page audit \+ priority queue\./);
    expect(body).toMatch(
      /- Per-runbook detail lives in `docs\/founder-actions\/v\*\.md` \+ `docs\/deployment\/\*\.md` \+ `docs\/operations\/\*\.md`\./,
    );
    expect(body).toMatch(/- Per-V-NNN history lives in `docs\/verification-log\.md`\./);
    expect(body).toMatch(/\*\*Last roll-up:\*\* 2026-05-07 \(V-279\)/);
  });

  it("10-section inventory framing pinned: '## 1. Backend (apps/server)' + '## 2. SDKs' + '## 3. GUI client (apps/gui-client)' + '## 4. Customer dashboard (apps/customer-dashboard)' + '## 5. Marketing site (apps/marketing-site)' + '## 6. Doc site (apps/docs)' + '## 7. Infrastructure (Hetzner / Neon / Upstash / Cloudflare / Postmark / Sentry)' + '## 8. Legal + corporate' + '## 9. Customer support readiness' + '## 10. Observability + operations' — pinned so the 10-section roll-up framing + Backend/SDKs/GUI/customer-dashboard/marketing/docs/Infra/Legal/Support/Ops inventory commitment survives", () => {
    expect(body).toMatch(/## 1\. Backend \(apps\/server\)/);
    expect(body).toMatch(/## 2\. SDKs/);
    expect(body).toMatch(/## 3\. GUI client \(apps\/gui-client\)/);
    expect(body).toMatch(/## 4\. Customer dashboard \(apps\/customer-dashboard\)/);
    expect(body).toMatch(/## 5\. Marketing site \(apps\/marketing-site\)/);
    expect(body).toMatch(/## 6\. Doc site \(apps\/docs\)/);
    expect(body).toMatch(
      /## 7\. Infrastructure \(Hetzner \/ Neon \/ Upstash \/ Cloudflare \/ Postmark \/ Sentry\)/,
    );
    expect(body).toMatch(/## 8\. Legal \+ corporate/);
    expect(body).toMatch(/## 9\. Customer support readiness/);
    expect(body).toMatch(/## 10\. Observability \+ operations/);
  });

  it('Backend §1 key READY items + current BillingService live-mode gate are pinned', () => {
    expect(body).toMatch(/Auth flows \(V-079\)/);
    expect(body).toMatch(/Web sessions \(V-168\) \+ API keys \(V-049\)/);
    expect(body).toMatch(/Sessions \(V-073 \+ V-100\)/);
    expect(body).toMatch(/Profiles \(V-081\)/);
    expect(body).toMatch(/Webhooks \(V-074 \+ V-091\)/);
    expect(body).toMatch(/Admin force-actions \(V-100\)/);
    expect(body).toMatch(/MFA \(V-353 cycle: a-h \+ V-358\)/);
    expect(body).toMatch(/BillingService production wiring\s*\|\s*PENDING FOUNDER\s*\|\s*founder/);
    expect(body).toMatch(
      /test mode is active; live launch needs `STRIPE_SECRET_KEY` \+ the 12-price six-tier map \+ `STRIPE_WEBHOOK_SECRET`\./,
    );
    expect(body).toMatch(/Live keys go via SSH-write only/);
    expect(body).toMatch(/Free entry tier\s*\|\s*READY/);
    expect(body).toMatch(
      /perpetual free tier; no card, expiry, one-time purchase, or prepaid credit/,
    );
    expect(body).not.toMatch(/STRIPE_TRIAL_PACK_PRICE_ID/);
    expect(body).toMatch(/Driver: webkit\s*\|\s*PENDING ENG\s*\|\s*Agent 1/);
    expect(body).toMatch(
      /cross-repo dep on Agent 1's V-203 Phase 2A \+ V-372–V-378 readback-path remediation/,
    );
  });

  it("Minimum-launchable + Founder-action-queue + What's-deferred + Cross-repo-deps framing pinned: '## Minimum-launchable surface (pre-payment-customer)' + '## Minimum-launchable surface (first-paying-customer-acceptable)' + '## Founder action queue (priority order)' + '## What's deferred post-launch (not blocking)' + '## Cross-repo dependencies (Agent 1)' — pinned so the 2-minimum-launchable-surfaces (pre-payment + first-paying) + founder-action-queue-priority + deferred-post-launch + Agent-1-cross-repo-deps commitment survives", () => {
    expect(body).toMatch(/## Minimum-launchable surface \(pre-payment-customer\)/);
    expect(body).toMatch(/## Minimum-launchable surface \(first-paying-customer-acceptable\)/);
    expect(body).toMatch(/## Founder action queue \(priority order\)/);
    expect(body).toMatch(/## What's deferred post-launch \(not blocking\)/);
    expect(body).toMatch(/## Cross-repo dependencies \(Agent 1\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
