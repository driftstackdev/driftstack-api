// W376.A — drift guard for marketing-site /trust/incidents page
// content. V-477. Existing trust-incidents-narrative-baseline +
// trust-incidents-policy-parity tests cover route shape. This
// guard pins the load-bearing posture-publishing claims:
//
//   • V-477 pre-launch posture framing pinned: list starts empty
//     + "first paying customer onward will land here" honesty.
//   • 3 incident severity values pinned in the Incident type:
//     major_outage / degraded / security. A schema add silently
//     renders undefined severityClass.
//   • severityLabel + severityClass map 3 severity values to
//     "Major outage" / "Degraded" / "Security" + bg colors.
//   • 4 "What we publish" bar entries: Customer-impacting
//     downtime / Security events / Sub-processor incidents /
//     Maintenance windows.
//   • 72-hour-advance maintenance window notice claim.
//   • Sub-processor incident reporting list pinned: Hetzner /
//     Neon / Upstash / Cloudflare / Postmark / Stripe / Sentry.
//   • "24h impact summary, 7 days root-cause + remediation" SLA
//     framing in page comment (matches /trust/security-overview).
//   • <StatusBadge /> embed in hero (live platform health).
//   • Empty-state UX present pre-launch.
//   • Cross-link to /trust (back to trust center).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/incidents.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W376.A marketing-site /trust/incidents page content parity', () => {
  const body = read(PAGE);

  it('V-477 pre-launch posture framing pinned (empty list + first-customer onward)', () => {
    expect(body).toMatch(/V-477 — public incident history/);
    expect(body).toMatch(
      /Pre-launch the list is empty;\s*\n?\s*\/\/\s*the page documents the framework so customers know what to expect/,
    );
  });

  it('3 incident severity values pinned in type union (major_outage / degraded / security)', () => {
    expect(body).toMatch(/severity: 'major_outage' \| 'degraded' \| 'security';/);
  });

  it('severityLabel maps to "Major outage" / "Degraded" / "Security" verbatim', () => {
    expect(body).toMatch(/case 'major_outage':\s*\n?\s*return 'Major outage';/);
    expect(body).toMatch(/case 'degraded':\s*\n?\s*return 'Degraded';/);
    expect(body).toMatch(/case 'security':\s*\n?\s*return 'Security';/);
  });

  it('severityClass color map pinned (red / amber / purple)', () => {
    expect(body).toMatch(/case 'major_outage':\s*\n?\s*return 'bg-red-100 text-red-800';/);
    expect(body).toMatch(/case 'degraded':\s*\n?\s*return 'bg-amber-100 text-amber-800';/);
    expect(body).toMatch(/case 'security':\s*\n?\s*return 'bg-purple-100 text-purple-800';/);
  });

  it('4 "What we publish" bar entries pinned (downtime / security / sub-processor / maintenance)', () => {
    expect(body).toMatch(
      /<p class="text-sm font-medium text-ink-primary">\s*Customer-impacting downtime\s*<\/p>/,
    );
    expect(body).toMatch(
      /<p class="text-sm font-medium text-ink-primary">\s*Security events\s*<\/p>/,
    );
    expect(body).toMatch(
      /<p class="text-sm font-medium text-ink-primary">\s*Sub-processor incidents\s*<\/p>/,
    );
    expect(body).toMatch(
      /<p class="text-sm font-medium text-ink-primary">\s*Maintenance windows\s*<\/p>/,
    );
  });

  it('72-hour-advance maintenance window notice claim pinned', () => {
    expect(body).toMatch(/Notice at least 72 hours in advance/);
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/settings"\s*\n?\s*class="text-oxblood-700 underline">\/settings → email preferences<\/a>/,
    );
  });

  it('sub-processor incident-reporting list pinned (Hetzner/Neon/Upstash/Cloudflare/Postmark/Stripe/Sentry)', () => {
    expect(body).toMatch(
      /When an upstream sub-processor \(Hetzner \/ Neon \/ Upstash \/\s+Cloudflare \/ Postmark \/ Stripe \/ Sentry\) has an incident\s+affecting our customers, we summarise their post-mortem and\s+link the upstream report\./,
    );
  });

  it('"24h impact summary, 7 days root-cause + remediation" SLA framing pinned', () => {
    expect(body).toMatch(
      /Each future incident gets an entry\s*\n?\s*\/\/\s*here within the SLA window \(24h impact summary, 7 days root-cause\s*\n?\s*\/\/\s*\+ remediation\)/,
    );
    // Customer-facing version of the same commitment.
    expect(body).toMatch(
      /Root cause and remediation are added within seven\s+days of the incident closing/,
    );
  });

  it('<StatusBadge /> embed in hero (live platform health surfacing)', () => {
    expect(body).toMatch(/import StatusBadge from '\.\.\/\.\.\/components\/StatusBadge\.astro';/);
    expect(body).toMatch(/<StatusBadge \/>/);
  });

  it('empty-state UX pinned ("No customer-impacting incidents to date.")', () => {
    expect(body).toMatch(/No customer-impacting incidents to date\./);
    expect(body).toMatch(
      /We've kept this list honest by entering it pre-launch — every\s+incident from the first paying customer onward will land here\./,
    );
  });

  it('cross-link to /trust (back to trust center) pinned', () => {
    expect(body).toMatch(/<a href="\/trust" class="btn-secondary">Back to trust center<\/a>/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/index.astro'))).toBe(
      true,
    );
  });

  it("'Get notified' CTA + Manage notifications link to dashboard /settings", () => {
    expect(body).toMatch(/Get notified when status changes\./);
    expect(body).toMatch(
      /<a\s*\n?\s*href="https:\/\/app\.driftstack\.dev\/settings"\s*\n?\s*class="btn-primary"\s*\n?\s*>\s*\n?\s*Manage notifications\s*\n?\s*<\/a>/,
    );
  });

  it('Incident interface includes optional root_cause + remediation fields (7-day-post-mortem render)', () => {
    expect(body).toMatch(/root_cause\?:\s*string;/);
    expect(body).toMatch(/remediation\?:\s*string;/);
  });
});
