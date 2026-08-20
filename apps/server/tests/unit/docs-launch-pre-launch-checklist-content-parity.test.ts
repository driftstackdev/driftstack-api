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

  // The roll-up header is from 2026-05-09 (V-361) while the verification log is
  // hundreds of entries past it, so anyone reading a row as current state is
  // reading a months-old snapshot. The staleness warning is the only thing
  // standing between that and a wrong launch decision, and nothing else fails if
  // it is deleted — hence pinned. It also records WHICH items were deliberately
  // left alone because their truth lives outside this repo.
  //
  // This case used to pin the literal `reached **V-750**`, which made a decaying
  // fact MANDATORY: the log passed V-750 within a week, and the assertion meant
  // the page could not be corrected without failing here. A pin that freezes a
  // number the world keeps changing turns a warning about staleness into a
  // staleness of its own. What is pinned now is the durable part — that the
  // warning names the roll-up it is warning about, and tells the reader how to
  // measure the gap themselves.
  it('V-750 staleness warning is present and still names the un-verifiable founder-side items', () => {
    expect(body).toMatch(/Staleness warning — read before trusting any row/);
    // The roll-up reference the warning is about — stable, unlike a log head.
    expect(body).toContain('2026-05-09 (V-361)');
    expect(body).toMatch(
      /compare the roll-up\s*\n?>?\s*reference against the head of `docs\/verification-log\.md`/,
    );
    // And it must NOT reintroduce a hard-coded log position, which is what made
    // this pin freeze a false statement in the first place.
    expect(
      body,
      'the warning quotes a fixed verification-log position again — that number goes stale within ' +
        'days and the pin then makes the stale value mandatory',
    ).not.toMatch(/reached \*\*V-\d+\*\*/);
    expect(body).toMatch(/Deliberately NOT changed/);
    expect(body).toMatch(/Re-verify those against the actual dashboards before launch/);
    // The two contradicted ADRs must stay named here, since the ADR files are not
    // what a launch reviewer opens first.
    expect(body).toMatch(/ADR-002 \(Stripe-only — crypto shipped\)/);
    expect(body).toMatch(/ADR-003/);
    // The corrected rows must not revert to their stale form.
    expect(body).not.toMatch(/1086 \/ 109 files server/);
    expect(body).not.toMatch(/^- Public status page \(status\.driftstack\.dev\)\.$/m);
    expect(body).not.toMatch(
      /^- Crypto rail re-evaluation \(deferred per ADR-002 supersedure to fiat-only\)\.$/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('V-1083 CRITICAL the test-coverage row points at the maintained ratchets instead of freezing a count. The page carries a staleness warning saying that quoting a fixed number is itself the failure it is about, and this row quoted one anyway — measured with the DB-gated integration files running, and behind by hundreds of files within nine days. The figure is deliberately not restated here — V-1058 caught this same guard-title mistake once already, and a retraction that quotes the count it retracts is the defect dressed as the correction.', () => {
    expect(body, 'the row no longer points at the ratchets').toMatch(
      /`EXPECTED_TEST_FILES` \/ `EXPECTED_TEST_FILES_ALL`/,
    );
    expect(body, 'the reason the pointer replaced a number is gone').toMatch(
      /read them rather than\s*\n?\s*a figure frozen here/,
    );

    // The frozen pair must not come back. A row that quotes a file count and a
    // test count is the shape that went stale.
    expect(body, 'the test-coverage row quotes a frozen file/test count again').not.toMatch(
      /\d{4} files \/ [\d,]+ tests pass repo-wide/,
    );

    // …and the constants it points at must still exist under those names.
    const gate = readFileSync(resolve(REPO_ROOT, 'scripts/verify-suite.mjs'), 'utf8');
    for (const name of ['EXPECTED_TEST_FILES', 'EXPECTED_TEST_FILES_ALL']) {
      expect(gate, `${name} is no longer exported, so the pointer is dangling`).toMatch(
        new RegExp(`export const ${name} = \\d+;`),
      );
    }
  });
});
