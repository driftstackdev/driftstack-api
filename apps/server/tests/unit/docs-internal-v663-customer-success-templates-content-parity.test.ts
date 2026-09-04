// W568.A — drift guard for /docs/internal/v663-customer-success-templates.md.
// V-663 TEMPLATES doc 2026-05-11 Wave-48. Drift here either weakens
// the voice-notes posture (Driftstack-first-plural, V-211 anonymity,
// plaintext-first), drops a cadence template, or unsets the V-543.B
// provisioning handoff (Postmark template ids + opt-out preference).
//
//   • V-663. TEMPLATES. Input to V-543.B implementation slice.
//   • 6 customer-facing templates: T+0 welcome / T+3d / T+14d /
//     at-risk usage-dropped / incident-note / tier-upgrade.
//   • 1 internal Slack-Connect on-the-hour health check.
//   • Variables in {{double_braces}}, snake_case convention.
//   • V-211 + V-205 sweep: no founder-name, no AI-tooling tokens.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v663-customer-success-templates.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W568.A /docs/internal/v663-customer-success-templates.md content parity', () => {
  const body = read(LIB);

  it('Header + V-663-TEMPLATES-Wave-48 + V-543-cadence + V-543.B-implementation-input + voice-notes + variable-conventions framing pinned', () => {
    expect(body).toMatch(/^# V-663 — customer success comms templates$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 48/);
    expect(body).toMatch(
      /\*\*Status:\*\* TEMPLATES — draft copy for every cadence touchpoint defined/,
    );
    expect(body).toMatch(/in the V-543 playbook\. Operator-editable; treat as a starting position/);
    expect(body).toMatch(/rather than locked copy\./);
    expect(body).toMatch(/V-543 defined _when_ customer-success touchpoints fire\. V-663 defines/);
    expect(body).toMatch(/_what_ each touchpoint says\. The templates here are the input to the/);
    expect(body).toMatch(
      /V-543\.B implementation slice \(Postmark template provisioning \+ admin-/,
    );
    expect(body).toMatch(/panel send buttons \+ scheduled follow-up cron\)\./);
    expect(body).toMatch(
      /- Driftstack-first person plural \("we"\), customer-first second person \("you"\)\./,
    );
    expect(body).toMatch(/- No founder name, no AI-tooling attribution \(V-211 \+ V-205\)\./);
    expect(body).toMatch(
      /- Lead with what's working \/ what's next\. Reserve apology language for actual incidents\./,
    );
    expect(body).toMatch(/- Skippable \/ opt-out always present; never gated\./);
    expect(body).toMatch(
      /- Plaintext-first; HTML variants only where formatting demonstrably helps \(lists, tables\)\./,
    );
    expect(body).toMatch(/## Variable conventions/);
    expect(body).toMatch(/Templates reference variables in `\{\{double_braces\}\}`\./);
    expect(body).toMatch(/- `\{\{customer_name\}\}` — first name from signup, falls back to email/);
    expect(body).toMatch(/- `\{\{dashboard_url\}\}` — deep-link to the customer's dashboard\./);
    expect(body).toMatch(/- `\{\{docs_url\}\}` — deep-link to the relevant docs section per/);
    expect(body).toMatch(/- `\{\{calendar_url\}\}` — onboarding call scheduling link \(currently/);
    expect(body).toMatch(/- `\{\{unsubscribe_url\}\}` — per-email unsubscribe \(mandatory\)\./);
    expect(body).toMatch(
      /- `\{\{tier_label\}\}` — current tier display name \("API Builder", etc\.\)\./,
    );
  });

  it('T+0 welcome + T+3d three-day-checkin + T+14d two-week-milestone framing pinned', () => {
    expect(body).toMatch(/## T\+0 — welcome-after-first-session/);
    expect(body).toMatch(
      /\*\*Trigger:\*\* `session\.completed_successfully` fires for the first time/,
    );
    expect(body).toMatch(/on an account \(V-304a\)\./);
    expect(body).toMatch(
      /\*\*Channel:\*\* Email \(Postmark template `customer-success\/welcome`\)\./,
    );
    expect(body).toMatch(/\*\*Subject:\*\* `Your first Driftstack session worked — what's next`/);
    expect(body).toMatch(/Your first Driftstack session ran successfully\. Quick orientation/);
    expect(body).toMatch(/1\. Bookmark your dashboard — that's where session activity, profile/);
    expect(body).toMatch(/2\. The \{\{tier_label\}\} tier docs walk through the patterns most/);
    expect(body).toMatch(/3\. Optional — we offer a 15-minute onboarding call if you'd like a/);
    expect(body).toMatch(/walkthrough of best practices specific to your use case\. No sales/);
    expect(body).toMatch(/## T\+3d — three-day-checkin/);
    expect(body).toMatch(
      /\*\*Trigger:\*\* 3 days after the welcome touchpoint, only if the customer/,
    );
    expect(body).toMatch(/has run at least one additional session\. \(No outreach to silent/);
    expect(body).toMatch(/accounts — V-543 explicit choice\.\)/);
    expect(body).toMatch(/\*\*Subject:\*\* `How's Driftstack treating you so far\?`/);
    expect(body).toMatch(/What's working: we see \{\{sessions_count_7d\}\} sessions on your/);
    expect(body).toMatch(
      /account over the past week, with a success rate of \{\{success_rate_7d\}\}%\./,
    );
    expect(body).toMatch(/- Webhook deliveries\. If you're polling for session state, you're/);
    expect(body).toMatch(/paying latency you don't have to\. Webhooks fire within 200ms of/);
    expect(body).toMatch(/- Profiles\. If you're recreating session state per run, persistent/);
    expect(body).toMatch(/- Cost dashboard\. Live spend \+ projected end-of-month — particularly/);
    expect(body).toMatch(/## T\+14d — two-week milestone/);
    expect(body).toMatch(/\*\*Subject:\*\* `Two weeks of Driftstack — small thing to ask`/);
    expect(body).toMatch(/Two weeks in\. If you have 60 seconds, two short questions that help/);
    expect(body).toMatch(/1\. What's the single biggest thing missing or annoying about/);
    expect(body).toMatch(/2\. What's the one thing you wish we'd build by end of quarter\?/);
    expect(body).toMatch(/· \{\{recent_changelog_bullet_1\}\}/);
    expect(body).toMatch(/· \{\{recent_changelog_bullet_2\}\}/);
    expect(body).toMatch(/· \{\{recent_changelog_bullet_3\}\}/);
  });

  it('At-risk usage-dropped + incident-note + tier-upgrade-nudge-on-cap-hit + Slack-Connect-internal + V-543.B provisioning handoff + V-205/V-211 sweep + sub-slices framing pinned', () => {
    expect(body).toMatch(/## At-risk: usage-dropped/);
    expect(body).toMatch(
      /\*\*Trigger:\*\* Account had ≥5 sessions\/week for 2 weeks, then dropped to/,
    );
    expect(body).toMatch(/0 sessions for 7 consecutive days \(V-543\.B-detected pattern\)\./);
    expect(body).toMatch(/\*\*Subject:\*\* `Anything blocking you on Driftstack\?`/);
    expect(body).toMatch(/We noticed your Driftstack usage paused this week\. No pressure —/);
    expect(body).toMatch(/· Did a session fail in a way we should fix\?/);
    expect(body).toMatch(/· Did pricing or quota become an issue\?/);
    expect(body).toMatch(/· Did you switch to another approach\?/);
    expect(body).toMatch(/## Incident: customer-facing post-incident note/);
    expect(body).toMatch(
      /\*\*Trigger:\*\* Manually sent by on-call after an incident affecting the/,
    );
    expect(body).toMatch(/specific customer's traffic resolves\./);
    expect(body).toMatch(
      /\*\*Subject:\*\* `\[Driftstack\] Post-incident note — \{\{incident_short_title\}\}`/,
    );
    expect(body).toMatch(/· What happened: \{\{incident_one_line_summary\}\}/);
    expect(body).toMatch(/· Customer impact for your account: \{\{customer_impact_summary\}\}/);
    expect(body).toMatch(/· Resolution: \{\{resolution_summary\}\}/);
    expect(body).toMatch(/· Time to detect: \{\{ttd_minutes\}\} min/);
    expect(body).toMatch(/· Time to recover: \{\{ttr_minutes\}\} min/);
    expect(body).toMatch(/## Tier-upgrade: nudge-on-cap-hit/);
    expect(body).toMatch(
      /\*\*Trigger:\*\* Customer hits their tier's concurrent-session cap 3\+ times/,
    );
    expect(body).toMatch(/in a 7-day window \(signal that they've outgrown the tier\)\./);
    expect(body).toMatch(/\*\*Channel:\*\* Email — once per 30 days max per account\./);
    expect(body).toMatch(/\*\*Subject:\*\* `Bumping into your tier limit — heads up`/);
    expect(body).toMatch(
      /Your Driftstack account hit the \{\{tier_label\}\} tier's concurrent-session/,
    );
    expect(body).toMatch(/cap three times this week\. Not blocking your work — sessions queue and/);
    expect(body).toMatch(/· Upgrade to the next tier — instant, prorated to the remaining/);
    expect(body).toMatch(/billing period: \{\{upgrade_url\}\}/);
    expect(body).toMatch(
      /Tier comparison side-by-side: https:\/\/driftstack\.io\/pricing\/comparison/,
    );
    expect(body).toMatch(/## Slack-Connect \(internal-team\): on-the-hour customer health/);
    expect(body).toMatch(
      /\*\*Channel:\*\* Slack DM to the on-call engineer \(V-543\.B-integrated\)\./,
    );
    expect(body).toMatch(/Not customer-facing\./);
    expect(body).toMatch(/:driftstack: Customer health check — \{\{time_label\}\}/);
    expect(body).toMatch(/Active customers: \{\{active_count\}\}/);
    expect(body).toMatch(/At-risk \(usage dropped 7d\): \{\{at_risk_count\}\}/);
    expect(body).toMatch(/Tier-cap hits last 24h: \{\{cap_hit_count\}\}/);
    expect(body).toMatch(/Failed sessions \/ total: \{\{failed_count\}\} \/ \{\{total_count\}\}/);
    expect(body).toMatch(/→ Open dashboard: \{\{ops_dashboard_url\}\}/);
    expect(body).toMatch(/## Provisioning notes \(V-543\.B handoff\)/);
    expect(body).toMatch(/1\. Each plain-text template above maps to one Postmark template id/);
    expect(body).toMatch(/2\. Schedule the cron-driven touchpoints \(T\+3d, T\+14d, at-risk/);
    expect(body).toMatch(/detection\) on top of the existing V-202d `scheduled_jobs` table\./);
    expect(body).toMatch(/3\. Manual touchpoints \(incident note, Slack health check\) get/);
    expect(body).toMatch(/4\. Every email respects `email_preferences\.customer_success_optout`/);
    expect(body).toMatch(/\(new column V-543\.B adds\)\. One-click unsubscribe in every email/);
    expect(body).toMatch(/## V-205 \+ V-211 sweep/);
    expect(body).toMatch(/- No founder-name tokens — all voice is collective "we \/ Driftstack"\./);
    expect(body).toMatch(/- No AI-tooling proper-noun strings\./);
    expect(body).toMatch(/- Variable names use `\{\{snake_case\}\}` consistently\./);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(/- \*\*V-663 \(THIS WAVE\):\*\* templates locked \(this doc\)\./);
    expect(body).toMatch(
      /- \*\*V-543\.B \(later\):\*\* Postmark provisioning \+ scheduled-job wiring \+/,
    );
    expect(body).toMatch(/admin-panel send-buttons \+ opt-out preference column\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
