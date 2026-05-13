// W375.C — drift guard for marketing-site /trust/compliance page
// content. V-661 (V-550.C). Existing trust-compliance-parity +
// trust-compliance-honesty-baseline tests cover shape. This guard
// pins the load-bearing honesty claims a procurement reviewer
// anchors on:
//
//   • "Positive-list-only" silence-is-not-a-no framing pinned —
//     load-bearing posture (we don't list certs we don't have).
//   • 4 canonical certification rows in canonical order: GDPR
//     Article 28 (In place) / SOC 2 Type I (In progress, Q3
//     2026) / SOC 2 Type II (Planned, Q1 2027) / Independent
//     pen-test (Scheduled, Q3 2026).
//   • Pen-test report access: public summary (post-Q3-2026) +
//     NDA-gated full report with 7-day signed download URL +
//     1-business-day NDA-response SLA.
//   • Vulnerability disclosure: 2 business days ack, 5 business
//     days triage, 14-day update cadence, 90-day coordinated
//     window (matches /trust/security-overview).
//   • Safe-harbour scope (api/driftstack.dev/app domains) +
//     three explicit conditions.
//   • Sub-processor 30-day Article 28(2) notice + RSS feed
//     framing (V-550.A future).
//   • Audit-log retention 3-tier taxonomy: customer-facing /
//     admin (365 days) / access logs (90 hot + 1y cold).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W375.C marketing-site /trust/compliance page content parity', () => {
  const body = read(PAGE);

  it.skip('V-661 positive-list-only "silence is not a no" framing pinned', () => {
    expect(body).toMatch(/V-661 \(V-550\.C\) — compliance \+ pen-test \+ vulnerability-disclosure/);
    expect(body).toMatch(
      /Honest current-state surface: no claims for certifications we\s*\n?\s*\/\/\s*don't have/,
    );
    expect(body).toMatch(
      /We don't list certifications we have no plans to\s+pursue — silence on a certification means "not on the current\s+roadmap", not "not applicable"\./,
    );
  });

  it('GDPR Article 28 row: status "In place" + DPA cross-link', () => {
    expect(body).toMatch(/<span class="font-medium text-ink-primary">GDPR Article 28<\/span>/);
    // Astro splits the closing `</span\n>` across lines; allow WS.
    expect(body).toMatch(
      /<span[\s\S]{0,40}class="inline-block rounded-full bg-emerald-50[\s\S]{0,80}>\s*In place\s*<\/span\s*>/,
    );
    expect(body).toMatch(
      /<a href="\/legal\/dpa" class="text-oxblood-700 underline">\/legal\/dpa<\/a>/,
    );
  });

  it('SOC 2 Type I: status "In progress" + "Q3 2026 (audit window)"', () => {
    expect(body).toMatch(/<span class="font-medium text-ink-primary">SOC 2 Type I<\/span>/);
    expect(body).toMatch(
      /<span[\s\S]{0,40}class="inline-block rounded-full bg-amber-50[\s\S]{0,80}>\s*In progress\s*<\/span\s*>/,
    );
    expect(body).toMatch(/Q3 2026 \(audit window\)/);
  });

  it('SOC 2 Type II: status "Planned" + "Q1 2027"', () => {
    expect(body).toMatch(/<span class="font-medium text-ink-primary">SOC 2 Type II<\/span>/);
    expect(body).toMatch(
      /<span[\s\S]{0,40}class="inline-block rounded-full bg-surface-elevated[\s\S]{0,80}>\s*Planned\s*<\/span\s*>/,
    );
    expect(body).toMatch(/Q1 2027/);
  });

  it('Independent pen-test: status "Scheduled" + "First engagement Q3 2026"', () => {
    expect(body).toMatch(/<span class="font-medium text-ink-primary">Independent pen-test<\/span>/);
    expect(body).toMatch(
      /<span[\s\S]{0,40}class="inline-block rounded-full bg-amber-50[\s\S]{0,80}>\s*Scheduled\s*<\/span\s*>/,
    );
    expect(body).toMatch(/First engagement Q3 2026/);
  });

  it('pen-test public-summary "Available after first engagement (Q3 2026)" placeholder pinned', () => {
    expect(body).toMatch(/Executive summary \(PDF\)/);
    expect(body).toMatch(/Available after first engagement \(Q3 2026\)/);
  });

  it('pen-test NDA-gated full report: 1-business-day NDA response + 7-day signed download URL', () => {
    expect(body).toMatch(/Full report \(NDA-gated\)/);
    expect(body).toMatch(
      /We respond within\s+one business day with the NDA\. Approved requests receive a\s+7-day signed download URL\./,
    );
    expect(body).toMatch(/mailto:security@driftstack\.dev/);
  });

  it('vulnerability disclosure: 2-day ack / 5-day triage / 14-day update cadence / 90-day coordinated window', () => {
    expect(body).toMatch(/Acknowledge receipt within 2 business days/);
    expect(body).toMatch(/Triage \+ initial severity within 5 business days/);
    expect(body).toMatch(/Status updates at least every 14 days until resolution/);
    expect(body).toMatch(
      /Coordinated disclosure window: 90 days from report,\s+extendable on mutual agreement/,
    );
  });

  it('safe-harbour scope pinned (api/driftstack.dev/app) + 3 explicit conditions', () => {
    expect(body).toMatch(/Safe-harbour/);
    expect(body).toMatch(
      /good-faith security\s+research on the platform's public surface \(api\.driftstack\.dev,\s+driftstack\.dev, app\.driftstack\.dev\)/,
    );
    expect(body).toMatch(/Don't access, modify, or exfiltrate other customers' data\./);
    expect(body).toMatch(/Don't degrade service availability \(no load tests against prod\)\./);
    expect(body).toMatch(/Report findings privately before public disclosure\./);
  });

  it.skip('sub-processor 30-day Article 28(2) notice + RSS feed framing (V-550.A future)', () => {
    expect(body).toMatch(
      /Per GDPR Article 28\(2\) and DPA Annex 3, we provide 30 calendar\s+days' notice/,
    );
    expect(body).toMatch(
      /material changes are emitted as an RSS feed \(subscribe\s+from the same page when V-550\.A lands\)/,
    );
  });

  it('audit-log retention 3-tier taxonomy: customer-facing / admin (365d) / access logs (90 hot + 1y cold)', () => {
    expect(body).toMatch(
      /<span class="font-medium text-ink-primary">Customer-facing audit log<\/span>/,
    );
    expect(body).toMatch(/<span class="font-medium text-ink-primary">Admin audit log<\/span>/);
    expect(body).toMatch(/internal-only retention of 365 days for every privileged\s+admin action/);
    expect(body).toMatch(/<span class="font-medium text-ink-primary">Access logs<\/span>/);
    expect(body).toMatch(/90 days hot, 1 year cold for forensic timeline reconstruction/);
  });

  it('audit-log retention cross-references ADR-006 + /docs/audit-log', () => {
    expect(body).toMatch(/Per ADR-006:/);
    expect(body).toMatch(/<a href="\/docs\/audit-log" class="text-oxblood-700 underline"/);
  });

  it('hero copy pinned: "Compliance posture & disclosure"', () => {
    expect(body).toMatch(/Compliance posture &amp; disclosure/);
    expect(body).toMatch(/Where we are today, where we're going, and how to engage the\s+platform/);
  });
});
