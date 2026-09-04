// W376.A — drift guard for marketing-site /trust/incidents page
// content. V-477. Existing trust-incidents-narrative-baseline +
// trust-incidents-policy-parity tests cover route shape. This
// guard pins the load-bearing posture-publishing claims:
//
//   • V-477 current disclosure-policy framing pinned.
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
//   • Empty-state UX reports the public history and live status.
//   • Live status + dashboard-notification CTAs.

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

  it('V-477 current disclosure-policy framing pinned', () => {
    expect(body).toMatch(/V-477 — public incident history and disclosure policy/);
    expect(body).not.toMatch(/pre-launch|first paying customer/i);
  });

  it('3 incident severity values pinned in type union (major_outage / degraded / security)', () => {
    expect(body).toMatch(/severity: 'major_outage' \| 'degraded' \| 'security';/);
  });

  it('severityLabel maps to "Major outage" / "Degraded" / "Security" verbatim', () => {
    expect(body).toMatch(/case 'major_outage':\s*return 'Major outage';/);
    expect(body).toMatch(/case 'degraded':\s*return 'Degraded';/);
    expect(body).toMatch(/case 'security':\s*return 'Security';/);
  });

  it('severityClass color map pinned (red / amber / purple)', () => {
    expect(body).toMatch(/case 'major_outage':\s*return 'bg-red-100 text-red-800';/);
    expect(body).toMatch(/case 'degraded':\s*return 'bg-amber-100 text-amber-800';/);
    expect(body).toMatch(/case 'security':\s*return 'bg-purple-100 text-purple-800';/);
  });

  it('4 "What we publish" bar entries pinned (downtime / security / sub-processor / maintenance)', () => {
    expect(body).toMatch(
      /<p class="text-sm font-medium text-tk-ink">\s*Customer-impacting downtime\s*<\/p>/,
    );
    expect(body).toMatch(/<p class="text-sm font-medium text-tk-ink">\s*Security events\s*<\/p>/);
    expect(body).toMatch(
      /<p class="text-sm font-medium text-tk-ink">\s*Sub-processor incidents\s*<\/p>/,
    );
    expect(body).toMatch(
      /<p class="text-sm font-medium text-tk-ink">\s*Maintenance windows\s*<\/p>/,
    );
  });

  it('72-hour-advance maintenance window notice claim pinned', () => {
    expect(body).toMatch(/Notice at least 72 hours in advance/);
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.io\/settings\/"\s*class="text-tk-accent-text underline">\/settings → email preferences<\/a>/,
    );
  });

  it('sub-processor incident-reporting list pinned (Hetzner/Neon/Upstash/Cloudflare/Postmark/Stripe/Sentry)', () => {
    expect(body).toMatch(
      /When an upstream sub-processor \(Hetzner \/ Neon \/ Upstash \/\s+Cloudflare \/ Postmark \/ Stripe \/ Sentry\) has an incident\s+affecting our customers, we summarise their post-mortem and\s+link the upstream report\./,
    );
  });

  it('"24h impact summary, 7 days root-cause + remediation" SLA framing pinned', () => {
    expect(body).toMatch(
      /Policy window: customer-impact summary within 24h; root-cause and\s*\/\/ remediation within 7 days of the incident closing/,
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
      /No incidents are recorded in the public history\. The live\s+platform status above reflects the current moment\./,
    );
  });

  it('live status CTA opens the public status page', () => {
    expect(body).toMatch(
      /primaryHref="https:\/\/status\.driftstack\.io"\s*primaryLabel="Open status page"/,
    );
  });

  it("'Get notified' CTA + Manage notifications link to dashboard /settings", () => {
    expect(body).toMatch(/title="Get notified when status changes\."/);
    expect(body).toMatch(
      /secondaryHref="https:\/\/app\.driftstack\.io\/settings\/"\s*secondaryLabel="Manage notifications"/,
    );
  });

  it('Incident interface includes optional root_cause + remediation fields (7-day-post-mortem render)', () => {
    expect(body).toMatch(/root_cause\?:\s*string;/);
    expect(body).toMatch(/remediation\?:\s*string;/);
  });
});
