// W565.A — drift guard for /docs/internal/v548-launch-week-comms-plan.md.
// V-548 PLAN doc 2026-05-11 Wave-24. Drift here either weakens the
// T-30/T-7/T-1/T+0/T+1-T+7/T+30 timeline, drops the 5 anti-actions
// (V-211 anonymity + V-205 no-tooling + no-LLM-vendor-marketing-
// promo + no-superlatives + no-team-size), or unsets the 6-row
// monitoring matrix during launch hour.
//
//   • V-548. PLAN. Launch-week comms cadence + copy targets.
//   • T-30 soft signaling + T-7 readiness + T-1 go/no-go + T+0
//     launch-day + T+1-T+7 launch-week + T+30 retro.
//   • Channels: marketing + email + social (LinkedIn/X/HN) + blog.
//   • 5 anti-actions including V-205 + V-211.
//   • 6-row monitoring matrix during launch hour.
//   • 3 open questions for team review.
//   • Sub-slices V-548.B (T-7) + V-548.C (T-3) + V-548.D (T-1).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v548-launch-week-comms-plan.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W565.A /docs/internal/v548-launch-week-comms-plan.md content parity', () => {
  const body = read(LIB);

  it("Header + V-548-PLAN-Wave-24 + 4-phase timeline framing pinned: '# V-548 — launch-week comms plan' + '**Date:** 2026-05-11' + '**Wave:** 24' + '**Status:** PLAN — activates when the team selects a launch date.' + '### T-30 days — soft signaling' + 'Marketing site is live; signups open in invite-only mode.' + 'A small list of invited early customers (5-10) gets first-touch' + '### T-7 days — pre-launch readiness' + 'Internal launch checklist completed (docs/runbooks/launch-day-' + 'runbook.md, V-516).' + 'Marketing-site hero copy locked.' + 'Pricing page locked.' + 'Security / DPA / privacy pages locked + legal reviewed.' + '### T-1 day — final go/no-go' + 'Production smoke tests green.' + 'Stripe live mode tested (single test transaction).' + 'Postmark / Sentry / Cloudflare all \"operational\" on their own' + 'Sub-processors list confirmed current.' + 'Rollback path documented.' — pinned so the V-548-PLAN-Wave-24-2026-05-11 + T-30-invite-only-5-10-early-customer + T-7-V-516-runbook-hero/pricing/security-locked + T-1-Stripe-live-test-single-txn-Postmark/Sentry/CF-operational commitment survives", () => {
    expect(body).toMatch(/^# V-548 — launch-week comms plan$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 24/);
    expect(body).toMatch(/\*\*Status:\*\* PLAN — activates when the team selects a launch date\./);
    expect(body).toMatch(/### T-30 days — soft signaling/);
    expect(body).toMatch(/- Marketing site is live; signups open in invite-only mode\./);
    expect(body).toMatch(/- A small list of invited early customers \(5-10\) gets first-touch/);
    expect(body).toMatch(/### T-7 days — pre-launch readiness/);
    expect(body).toMatch(/- Internal launch checklist completed \(docs\/runbooks\/launch-day-/);
    expect(body).toMatch(/runbook\.md, V-516\)\./);
    expect(body).toMatch(/- Marketing-site hero copy locked\./);
    expect(body).toMatch(/- Pricing page locked\./);
    expect(body).toMatch(/- Security \/ DPA \/ privacy pages locked \+ legal reviewed\./);
    expect(body).toMatch(/### T-1 day — final go\/no-go/);
    expect(body).toMatch(/- Production smoke tests green\./);
    expect(body).toMatch(/- Stripe live mode tested \(single test transaction\)\./);
    expect(body).toMatch(/- Postmark \/ Sentry \/ Cloudflare all "operational" on their own/);
    expect(body).toMatch(/- Sub-processors list confirmed current\./);
    expect(body).toMatch(/- Rollback path documented\./);
  });

  it("T+0 launch-day + T+1-T+7 launch-week + T+30 retro framing pinned: '### T+0 — launch day' + 'Hour 0 (morning UK time):' + 'Marketing-site signups flip from invite-only to public.' + 'Launch announcement email sent to pre-registered list.' + 'Hacker News post submitted (Show HN: Driftstack — iPhone Safari' + 'automation API).' + 'LinkedIn + X posts go live.' + 'Status-page banner: \"Driftstack is now publicly available\".' + 'Hour 0-6: active monitoring.' + 'Live Sentry dashboard open.' + 'Cost dashboard (V-541) reviewed every 30min.' + 'New signup count tracked manually.' + 'Any signup that goes to first-session-success → manual welcome reply' + 'Hour 6-24: monitored, less intensively.' + '### T+1 to T+7 — launch week' + 'Daily 09:00 standup-with-self: signup count, top error rates,' + 'T+3 mid-week social repost.' + 'T+7 launch-week recap blog post (numbers + lessons).' + '### T+30 — retrospective' + 'Public retro post: what worked, what didn't.' + 'Internal retro: same content, plus the things that won't go public' + 'Sub-processor performance review — did anything degrade under load?' — pinned so the T+0-hour-0-UK-morning + Show-HN-Driftstack-iPhone-Safari + LinkedIn+X + V-541-cost-30min-cadence + T+3-mid-week-repost + T+7-launch-recap + T+30-public-internal-retro commitment survives", () => {
    expect(body).toMatch(/### T\+0 — launch day/);
    expect(body).toMatch(/Hour 0 \(morning UK time\):/);
    expect(body).toMatch(/- Marketing-site signups flip from invite-only to public\./);
    expect(body).toMatch(/- Launch announcement email sent to pre-registered list\./);
    expect(body).toMatch(/- Hacker News post submitted \(Show HN: Driftstack — iPhone Safari/);
    expect(body).toMatch(/automation API\)\./);
    expect(body).toMatch(/- LinkedIn \+ X posts go live\./);
    expect(body).toMatch(/- Status-page banner: "Driftstack is now publicly available"\./);
    expect(body).toMatch(/Hour 0-6: active monitoring\./);
    expect(body).toMatch(/- Live Sentry dashboard open\./);
    expect(body).toMatch(/- Cost dashboard \(V-541\) reviewed every 30min\./);
    expect(body).toMatch(/- New signup count tracked manually\./);
    expect(body).toMatch(/- Any signup that goes to first-session-success → manual welcome reply/);
    expect(body).toMatch(/Hour 6-24: monitored, less intensively\./);
    expect(body).toMatch(/### T\+1 to T\+7 — launch week/);
    expect(body).toMatch(/- Daily 09:00 standup-with-self: signup count, top error rates,/);
    expect(body).toMatch(/- T\+3 mid-week social repost\./);
    expect(body).toMatch(/- T\+7 launch-week recap blog post \(numbers \+ lessons\)\./);
    expect(body).toMatch(/### T\+30 — retrospective/);
    expect(body).toMatch(/- Public retro post: what worked, what didn't\./);
    expect(body).toMatch(/- Internal retro: same content, plus the things that won't go public/);
    expect(body).toMatch(/- Sub-processor performance review — did anything degrade under load\?/);
  });

  it("Channels + 5-anti-action + monitoring + open-questions + sub-slices framing pinned: '## Channels + copy targets' + 'Hero — the one-line value prop' + '5th-grade reading level.' + 'Pricing — 3 visible tiers + \"contact us\" for enterprise.' + 'LinkedIn — single post. Technical-credible framing.' + 'HN — `Show HN: Driftstack — iPhone Safari automation API`.' + '## Anti-actions' + '**No** founder-personal-brand framing in any public copy (V-211' + '**No** tooling references (V-205)' + '**No** mention of Anthropic / Claude / GPT in marketing copy outside' + '**No** \"world-first\" / \"world's-best\" superlatives' + '**No** revealing the team size or composition.' + '## Monitoring during launch hour' + '| Signup rate             | `/v1/admin/overview`           | Surge >100/hour → check abuse' + '| First-session-success   | session_lifecycle table        | <50% of signups → integration issue' + '| API error rate          | Sentry                         | >2% → investigate' + '| Postmark queue depth    | Postmark dashboard             | >100 → email delivery degrading' + '| Stripe failures         | Stripe dashboard               | Any failed live charge → investigate' + '## Open questions for team review' + '**Launch hour timing.** UK morning (9am UK = 4am ET = 1am PT' + '**HN posting account.** A personal account' + '**Pre-launch email list source.**' + '## Sub-slices' + '**V-548.B** — copy locked: marketing hero + pricing + launch email' + '**V-548.C** — Postmark templates `launch-announcement` +' + '`trial-promotion`. Lands T-3 days.' + '**V-548.D** — launch-day-runbook amendment' — pinned so the 3-tier-pricing-enterprise-contact + 5-anti-action (V-211-personal-brand + V-205-tooling + Anthropic/Claude/GPT-non-promo + superlatives + team-size) + 6-monitoring-row (signup/first-session/API-error/Postmark-queue/Stripe-fail/status-subscribers) + 3-open-question + 3-sub-slice commitment survives", () => {
    expect(body).toMatch(/## Channels \+ copy targets/);
    expect(body).toMatch(/- Hero — the one-line value prop/);
    expect(body).toMatch(/5th-grade reading level\./);
    expect(body).toMatch(/- Pricing — 3 visible tiers \+ "contact us" for enterprise\./);
    expect(body).toMatch(/- LinkedIn — single post\. Technical-credible framing\./);
    expect(body).toMatch(/- HN — `Show HN: Driftstack — iPhone Safari automation API`\./);
    expect(body).toMatch(/## Anti-actions/);
    expect(body).toMatch(/- \*\*No\*\* founder-personal-brand framing in any public copy \(V-211/);
    expect(body).toMatch(/- \*\*No\*\* tooling references \(V-205\)/);
    expect(body).toMatch(
      /- \*\*No\*\* mention of Anthropic \/ Claude \/ GPT in marketing copy outside/,
    );
    expect(body).toMatch(/- \*\*No\*\* "world-first" \/ "world's-best" superlatives/);
    expect(body).toMatch(/- \*\*No\*\* revealing the team size or composition\./);
    expect(body).toMatch(/## Monitoring during launch hour/);
    expect(body).toMatch(
      /\| Signup rate\s+\| `\/v1\/admin\/overview`\s+\| Surge >100\/hour → check abuse/,
    );
    expect(body).toMatch(
      /\| First-session-success\s+\| session_lifecycle table\s+\| <50% of signups → integration issue/,
    );
    expect(body).toMatch(/\| API error rate\s+\| Sentry\s+\| >2% → investigate/);
    expect(body).toMatch(
      /\| Postmark queue depth\s+\| Postmark dashboard\s+\| >100 → email delivery degrading/,
    );
    expect(body).toMatch(
      /\| Stripe failures\s+\| Stripe dashboard\s+\| Any failed live charge → investigate/,
    );
    expect(body).toMatch(/## Open questions for team review/);
    expect(body).toMatch(/1\. \*\*Launch hour timing\.\*\* UK morning \(9am UK = 4am ET = 1am PT/);
    expect(body).toMatch(/2\. \*\*HN posting account\.\*\* A personal account/);
    expect(body).toMatch(/3\. \*\*Pre-launch email list source\.\*\*/);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(
      /- \*\*V-548\.B\*\* — copy locked: marketing hero \+ pricing \+ launch email/,
    );
    expect(body).toMatch(/- \*\*V-548\.C\*\* — Postmark templates `launch-announcement` \+/);
    expect(body).toMatch(/`trial-promotion`\. Lands T-3 days\./);
    expect(body).toMatch(/- \*\*V-548\.D\*\* — launch-day-runbook amendment/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
